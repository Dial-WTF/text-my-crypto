import { eq } from "drizzle-orm";
import {
  AccountRole,
  decompileTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { MEMO_PROGRAM_ADDRESS, parseAddMemoInstruction } from "@solana-program/memo";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { type ActionsChain, actionsChain, MAX_OPEN_PER_HANDLE, newReference, payActionMetadata, preparePayment } from "@/lib/actions/pay";
import { recordActionPayments } from "@/lib/actions/record";
import { ACTIONS_JSON, actionHeaders } from "@/lib/actions/spec";
import type { BotDeps } from "@/lib/bot/types";
import { actionPayments } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import { featuresOf, type PaymentActions } from "@/lib/settlement/capabilities";
import { REGISTRY, type SolanaNetwork } from "@/lib/settlement/registry";
import { buildPayTransaction, type ConfirmedTx, paidTo } from "@/lib/settlement/solana-actions";
import { movedByChain, publicStats, recentPayments } from "@/lib/stats";
import { getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const entry = REGISTRY.solana.testnet as SolanaNetwork;
const now = new Date("2026-10-09T12:00:00Z");
const PAYER = newReference();
const ALEX_WALLET = newReference();
const LIFETIME = { blockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1EtWTRABZaYq6", lastValidBlockHeight: 1000n };

type Landed = { txHash: string; explorerUrl: string; payer: string; amount: bigint; to: string };

/** An `actions` module with the real transaction builder and a "chain" a test lands payments on. */
function fakeActions() {
  const landed = new Map<string, Landed[]>();
  const state = { down: false };
  const actions: PaymentActions = {
    blockchainId: entry.caip2,
    buildPayment: (args) => buildPayTransaction({ ...args, mint: entry.mint, lifetime: LIFETIME }),
    findByReference: async (reference, recipient) => {
      if (state.down) throw new Error("RPC 503");
      return (landed.get(reference) ?? []).filter((p) => p.to === recipient);
    },
  };
  const land = (reference: string, txHash: string, amount: bigint, to = ALEX_WALLET) =>
    landed.set(reference, [...(landed.get(reference) ?? []), { txHash, explorerUrl: entry.explorerTx(txHash), payer: PAYER, amount, to }]);
  return { module: actions, state, land };
}

async function setup(overrides: Partial<BotDeps> = {}) {
  const db = await createTestDb();
  const alex = await createUser(db, { phone: "+15550000010", handle: "alex", name: "Alex Rivera" }, now);
  const sms = smsSink();
  const actions = fakeActions();
  const adapter = {
    ...fakeAdapter({ defaultBalance: 100_000_000n }),
    createWallet: async () => ({ address: ALEX_WALLET, secret: new Uint8Array(32) }),
    actions: actions.module,
  };
  const deps = testDeps(db, { adapters: { solana: adapter }, sendSms: sms.sendSms, now: () => now, ...overrides });
  const on: ActionsChain = { chain: "solana", adapter, module: actions.module };
  return { db, alex, sms, deps, adapter, actions, on };
}

function decode(base64: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return { tx, compiled, message: decompileTransactionMessage(compiled) };
}

describe("pay action GET", () => {
  it("offers $1, $5, $10 and a custom amount up to the cap, with an absolute icon", async () => {
    const { deps } = await setup();
    const body = payActionMetadata(deps, "solana", { handle: "alex", name: "Alex Rivera" }, {});
    expect(body).toMatchObject({ type: "action", icon: "https://tmc.test/pay/alex/card", title: "Pay Alex Rivera (@alex)", label: "Pay" });
    expect(body.description).toContain("Solana devnet");
    const actions = body.links?.actions ?? [];
    expect(actions.map((a) => [a.label, a.href])).toEqual([
      ["$1", "https://tmc.test/api/actions/pay/alex?amount=1"],
      ["$5", "https://tmc.test/api/actions/pay/alex?amount=5"],
      ["$10", "https://tmc.test/api/actions/pay/alex?amount=10"],
      ["Pay", "https://tmc.test/api/actions/pay/alex?amount={amount}"],
    ]);
    expect(actions[3]?.parameters).toEqual([{ type: "number", name: "amount", label: "Amount in USD, up to $50", required: true, min: 0.01, max: 50 }]);
    expect(actions.every((a) => a.type === "transaction")).toBe(true);
  });

  it("a link with an amount gets one button for it; presets over the cap are left out", async () => {
    const { deps } = await setup();
    const asked = payActionMetadata(deps, "solana", { handle: "alex", name: null }, { amount: "7.50", note: "pizza" });
    expect(asked.title).toBe("Pay @alex $7.50 for pizza");
    expect(asked.icon).toBe("https://tmc.test/pay/alex/card?amount=7.50&note=pizza");
    expect(asked.links?.actions).toEqual([{ type: "transaction", label: "Pay $7.50", href: "https://tmc.test/api/actions/pay/alex?amount=7.50&note=pizza" }]);

    const small = payActionMetadata({ ...deps, perTxCap: 5_000_000n }, "solana", { handle: "alex", name: null }, {});
    expect(small.links?.actions.map((a) => a.label)).toEqual(["$1", "$5", "Pay"]);
    // An amount over the cap isn't offered.
    const over = payActionMetadata(deps, "solana", { handle: "alex", name: null }, { amount: "500" });
    expect(over.links?.actions).toHaveLength(4);
  });
});

describe("Actions headers, actions.json and the capability", () => {
  it("carries CORS, the spec version and the devnet chain id", () => {
    const h = actionHeaders(entry.caip2);
    expect(h["access-control-allow-origin"]).toBe("*");
    expect(h["access-control-allow-methods"]).toBe("GET,POST,PUT,OPTIONS");
    expect(h["access-control-allow-headers"]).toContain("X-Accept-Action-Version");
    expect(h["access-control-expose-headers"]).toBe("X-Action-Version, X-Blockchain-Ids");
    expect(h["x-action-version"]).toBe("2.4");
    expect(h["x-blockchain-ids"]).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });

  it("maps /@handle and /pay/handle to the pay action the way Dialect's matcher reads the rules", () => {
    // Dialect's BlinksURLMapper, as published in @dialectlabs/blinks-core.
    const map = (path: string) => {
      for (const r of ACTIONS_JSON.rules) {
        const m = path.match(new RegExp(`^${r.pathPattern.replace(/\*\*/g, "(.*)").replace(/\/(\*)/g, "/([^/]+)")}$`));
        if (m) return m.slice(1).reduce((p, g) => p.replace(/\*+/, g), r.apiPath);
      }
      return null;
    };
    expect(map("/@alex")).toBe("/api/actions/pay/alex");
    expect(map("/pay/alex")).toBe("/api/actions/pay/alex");
    expect(map("/api/actions/pay/alex")).toBe("/api/actions/pay/alex");
    expect(map("/ledger")).toBeNull();
  });

  it("is found by capability, not by chain name", async () => {
    const { deps, adapter } = await setup();
    expect(featuresOf(adapter)).toContain("actions");
    expect(actionsChain(deps.adapters)?.chain).toBe("solana");
    expect(actionsChain({ solana: fakeAdapter() })).toBeNull();
  });
});

describe("pay action POST", () => {
  it("builds a devnet USDC transfer the payer signs: create ATA, transfer with the reference, memo", async () => {
    const { db, alex, deps, on } = await setup();
    const res = await preparePayment(deps, on, { handle: "alex", account: PAYER, amount: "5", note: "pizza" });
    if (!res.ok) throw new Error(res.message);
    expect(res.message).toBe("Pays $5 USDC to @alex's Dial wallet.");

    const { tx, compiled, message } = decode(res.transaction);
    // One signature slot, for the payer, left empty for their wallet.
    expect(Object.keys(tx.signatures)).toEqual([PAYER]);
    expect(compiled.staticAccounts[0]).toBe(PAYER);
    expect(message.feePayer.address).toBe(PAYER);

    const [create, transfer, memo] = message.instructions;
    expect(message.instructions).toHaveLength(3);
    expect(create?.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(transfer?.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(memo?.programAddress).toBe(MEMO_PROGRAM_ADDRESS);

    const ataOf = async (owner: string) =>
      (await findAssociatedTokenPda({ owner: owner as never, mint: entry.mint as never, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
    const [alexAta, payerAta] = await Promise.all([ataOf(ALEX_WALLET), ataOf(PAYER)]);
    const c = parseCreateAssociatedTokenIdempotentInstruction(create as never);
    expect([c.accounts.payer.address, c.accounts.ata.address, c.accounts.owner.address, c.accounts.mint.address]).toEqual([
      PAYER,
      alexAta,
      ALEX_WALLET,
      entry.mint,
    ]);
    const t = parseTransferCheckedInstruction({ ...transfer, accounts: transfer?.accounts?.slice(0, 4) } as never);
    expect(t.data.amount).toBe(5_000_000n);
    expect(t.data.decimals).toBe(6);
    expect([t.accounts.source.address, t.accounts.destination.address, t.accounts.authority.address]).toEqual([payerAta, alexAta, PAYER]);
    // The reference rides on the transfer as a read-only, non-signing account.
    expect(transfer?.accounts?.[4]).toEqual({ address: res.reference, role: AccountRole.READONLY });
    expect(parseAddMemoInstruction(memo as never).data.memo).toBe(res.id);

    const [row] = await db.select().from(actionPayments).where(eq(actionPayments.id, res.id));
    expect(row).toMatchObject({
      reference: res.reference,
      recipientId: alex.id,
      chain: "solana",
      recipientAddress: ALEX_WALLET,
      payerAddress: PAYER,
      amount: 5_000_000n,
      note: "pizza",
      signature: null,
    });
    expect((await getWallet(db, alex.id, "solana"))?.address).toBe(ALEX_WALLET);
  });

  it("refuses amounts outside $0.01 to the cap, bad accounts, unknown handles and thin wallets", async () => {
    const { deps, adapter, on } = await setup();
    const post = (input: { handle?: string; account?: unknown; amount?: string | null }) =>
      preparePayment(deps, on, { handle: "alex", account: PAYER, amount: "5", ...input });

    for (const amount of ["0", "0.001", "50.01", "-1", "abc", null]) {
      expect(await post({ amount })).toEqual({ ok: false, status: 400, message: "Amounts can be from $0.01 to $50." });
    }
    expect((await post({ amount: "50" })).ok).toBe(true);
    expect((await post({ amount: "0.01" })).ok).toBe(true);
    expect(await post({ account: "not-an-address" })).toEqual({ ok: false, status: 400, message: "That isn't a wallet address." });
    expect(await post({ account: 42 })).toMatchObject({ ok: false, status: 400 });
    expect(await post({ handle: "nobody" })).toEqual({ ok: false, status: 404, message: "No Dial user with that handle." });
    expect(await post({ account: ALEX_WALLET })).toEqual({ ok: false, status: 400, message: "That is @alex's own Dial wallet." });

    adapter.balances.set(PAYER, 2_000_000n);
    expect(await post({})).toEqual({ ok: false, status: 400, message: "This wallet has $2 in test USDC, not $5. Get test USDC at faucet.circle.com." });
    // A balance the RPC couldn't read doesn't block: the wallet's own simulation will.
    const blind = { ...on, adapter: { ...adapter, getBalance: async () => Promise.reject(new Error("RPC 503")) } };
    expect((await preparePayment(deps, blind, { handle: "alex", account: PAYER, amount: "5" })).ok).toBe(true);
  });

  it("caps how many unpaid transactions one handle can have out", async () => {
    const { deps, on } = await setup();
    for (let i = 0; i < MAX_OPEN_PER_HANDLE; i++) {
      expect((await preparePayment(deps, on, { handle: "alex", account: PAYER, amount: "1" })).ok).toBe(true);
    }
    expect(await preparePayment(deps, on, { handle: "alex", account: PAYER, amount: "1" })).toMatchObject({ ok: false, status: 429 });
  });
});

describe("reference matcher", () => {
  async function prepared(deps: BotDeps, on: ActionsChain, amount = "5") {
    const res = await preparePayment(deps, on, { handle: "alex", account: PAYER, amount, note: "pizza" });
    if (!res.ok) throw new Error(res.message);
    return res;
  }

  it("records a landed payment once, as from the paying wallet, and texts the recipient once", async () => {
    const { db, deps, sms, actions, on } = await setup();
    const res = await prepared(deps, on);
    const run = () => recordActionPayments(deps);

    expect(await run()).toEqual({ recorded: 0, expired: 0, errors: 0 });
    actions.land(res.reference, "SigOne", 5_000_000n);
    // Two passes at once (a slow minute overlapping the next) still record it once.
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.recorded + b.recorded).toBe(1);
    expect(await run()).toEqual({ recorded: 0, expired: 0, errors: 0 });

    const [row] = await db.select().from(actionPayments).where(eq(actionPayments.id, res.id));
    expect(row).toMatchObject({ signature: "SigOne", received: 5_000_000n, payerAddress: PAYER, paidAt: now });
    expect(row?.explorerUrl).toBe("https://explorer.solana.com/tx/SigOne?cluster=devnet");
    const short = `${PAYER.slice(0, 4)}...${PAYER.slice(-4)}`;
    expect(sms.to("+15550000010")).toEqual([
      `Alex Rivera, you got $5 from ${short} (pizza) on Solana. Receipt: https://explorer.solana.com/tx/SigOne?cluster=devnet`,
    ]);

    // On the public ledger and in the stats, from the wallet address, never a phone number.
    const feed = await recentPayments(db, 8);
    expect(feed.map((f) => [f.id, f.from, f.to, f.amount, f.status, f.txHash])).toEqual([
      [res.id, `${PAYER.slice(0, 4)}…${PAYER.slice(-4)}`, "@alex", 5_000_000n, "settled", "SigOne"],
    ]);
    expect(await publicStats(db)).toEqual({ payments: 1, movedUsd: 5_000_000n, people: 1 });
    expect(await movedByChain(db)).toEqual({ solana: 1 });
  });

  it("never records one signature for two references", async () => {
    const { deps, sms, actions, on } = await setup();
    const one = await prepared(deps, on);
    const two = await prepared(deps, on);
    actions.land(one.reference, "SigShared", 5_000_000n);
    actions.land(two.reference, "SigShared", 5_000_000n);
    expect((await recordActionPayments(deps)).recorded).toBe(1);
    expect(sms.to("+15550000010")).toHaveLength(1);
  });

  it("records what actually arrived, and ignores transfers to someone else", async () => {
    const { db, deps, actions, on } = await setup();
    const res = await prepared(deps, on, "10");
    actions.land(res.reference, "SigElsewhere", 10_000_000n, newReference());
    expect((await recordActionPayments(deps)).recorded).toBe(0);
    actions.land(res.reference, "SigLess", 3_000_000n);
    expect((await recordActionPayments(deps)).recorded).toBe(1);
    const [row] = await db.select().from(actionPayments).where(eq(actionPayments.id, res.id));
    expect(row).toMatchObject({ signature: "SigLess", received: 3_000_000n, amount: 10_000_000n });
  });

  it("drops references that expired unpaid, keeps them while the RPC is down, and purges them a day on", async () => {
    const { db, deps, actions, on } = await setup();
    const res = await prepared(deps, on);
    const later = { ...deps, now: () => new Date(now.getTime() + 31 * 60_000) };
    actions.state.down = true;
    expect(await recordActionPayments(later)).toEqual({ recorded: 0, expired: 0, errors: 1 });
    expect(await db.select().from(actionPayments)).toHaveLength(1);
    actions.state.down = false;
    expect(await recordActionPayments(later)).toEqual({ recorded: 0, expired: 1, errors: 0 });
    expect(await db.select().from(actionPayments).where(eq(actionPayments.id, res.id))).toHaveLength(0);

    await prepared(deps, on);
    actions.state.down = true;
    const nextDay = { ...deps, now: () => new Date(now.getTime() + 25 * 60 * 60_000) };
    expect(await recordActionPayments(nextDay)).toEqual({ recorded: 0, expired: 0, errors: 0 });
    expect(await db.select().from(actionPayments)).toHaveLength(0);
  });
});

describe("Solana transfer reading", () => {
  it("paidTo reads the recipient's gain and the wallet the money left", () => {
    const tx: ConfirmedTx = {
      err: null,
      feePayer: "FeePayer",
      pre: [{ accountIndex: 1, mint: entry.mint, owner: "Payer", uiTokenAmount: { amount: "9000000" } }],
      // The recipient's account didn't exist before: it only appears in post balances.
      post: [
        { accountIndex: 1, mint: entry.mint, owner: "Payer", uiTokenAmount: { amount: "4000000" } },
        { accountIndex: 2, mint: entry.mint, owner: "Alex", uiTokenAmount: { amount: "5000000" } },
      ],
    };
    expect(paidTo(tx, entry.mint, "Alex")).toEqual({ received: 5_000_000n, from: "Payer" });
    expect(paidTo(tx, "OtherMint", "Alex")).toBeNull();
    expect(paidTo(tx, entry.mint, "Someone")).toBeNull();
    expect(paidTo({ ...tx, err: { InstructionError: [1, "Custom"] } }, entry.mint, "Alex")).toBeNull();
  });
});

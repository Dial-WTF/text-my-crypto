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
import { MAX_OPEN_PER_HANDLE, newReference, payActionMetadata, preparePayment } from "@/lib/actions/pay";
import { recordActionPayments, paidTo } from "@/lib/actions/record";
import type { ActionChainReader, ConfirmedTx } from "@/lib/actions/rpc";
import { ACTIONS_JSON, actionHeaders } from "@/lib/actions/spec";
import type { BotDeps } from "@/lib/bot/types";
import { actionPayments } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import { REGISTRY, type SolanaNetwork } from "@/lib/settlement/registry";
import { movedByChain, publicStats, recentPayments } from "@/lib/stats";
import { getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const entry = REGISTRY.solana.testnet as SolanaNetwork;
const now = new Date("2026-10-09T12:00:00Z");
const PAYER = newReference();
const ALEX_WALLET = newReference();

/** A chain reader with a payer balance, a fixed blockhash, and whatever transactions a test puts on "chain". */
function fakeReader(balance: bigint | null = 100_000_000n) {
  const byReference = new Map<string, Array<{ signature: string; err: unknown }>>();
  const txs = new Map<string, ConfirmedTx>();
  const calls = { signatures: 0 };
  let down = false;
  const reader: ActionChainReader = {
    latestBlockhash: async () => ({ blockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1EtWTRABZaYq6", lastValidBlockHeight: 1000n }),
    tokenBalance: async () => balance,
    signatures: async (ref) => {
      calls.signatures++;
      if (down) throw new Error("RPC 503");
      return byReference.get(ref) ?? [];
    },
    transaction: async (sig) => txs.get(sig) ?? null,
  };
  return {
    reader,
    calls,
    setDown: (v: boolean) => {
      down = v;
    },
    /** Lands a transfer of `amount` from `from` to `to` that carries `reference`. */
    land(reference: string, signature: string, amount: bigint, opts: { to?: string; from?: string; err?: unknown } = {}) {
      byReference.set(reference, [{ signature, err: opts.err ?? null }, ...(byReference.get(reference) ?? [])]);
      const bal = (accountIndex: number, owner: string, amt: bigint) => ({ accountIndex, mint: entry.mint, owner, uiTokenAmount: { amount: String(amt) } });
      const from = opts.from ?? PAYER;
      txs.set(signature, {
        err: opts.err ?? null,
        feePayer: from,
        pre: [bal(1, from, 100_000_000n), bal(2, opts.to ?? ALEX_WALLET, 0n)],
        post: [bal(1, from, 100_000_000n - amount), bal(2, opts.to ?? ALEX_WALLET, amount)],
      });
    },
  };
}

async function setup(overrides: Partial<BotDeps> = {}) {
  const db = await createTestDb();
  const alex = await createUser(db, { phone: "+15550000010", handle: "alex", name: "Alex Rivera" }, now);
  const sms = smsSink();
  const adapter = { ...fakeAdapter(), createWallet: async () => ({ address: ALEX_WALLET, secret: new Uint8Array(32) }) };
  const deps = testDeps(db, { adapters: { solana: adapter }, sendSms: sms.sendSms, now: () => now, ...overrides });
  return { db, alex, sms, deps };
}

function decode(base64: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return { tx, compiled, message: decompileTransactionMessage(compiled) };
}

describe("pay action GET", () => {
  it("offers $1, $5, $10 and a custom amount up to the cap, with an absolute icon", async () => {
    const { deps } = await setup();
    const body = payActionMetadata(deps, { handle: "alex", name: "Alex Rivera" }, {}, entry);
    expect(body).toMatchObject({
      type: "action",
      icon: "https://tmc.test/pay/alex/card",
      title: "Pay Alex Rivera (@alex)",
      label: "Pay",
    });
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
    const asked = payActionMetadata(deps, { handle: "alex", name: null }, { amount: "7.50", note: "pizza" }, entry);
    expect(asked.title).toBe("Pay @alex $7.50 for pizza");
    expect(asked.icon).toBe("https://tmc.test/pay/alex/card?amount=7.50&note=pizza");
    expect(asked.links?.actions).toEqual([{ type: "transaction", label: "Pay $7.50", href: "https://tmc.test/api/actions/pay/alex?amount=7.50&note=pizza" }]);

    const small = payActionMetadata({ ...deps, perTxCap: 5_000_000n }, { handle: "alex", name: null }, {}, entry);
    expect(small.links?.actions.map((a) => a.label)).toEqual(["$1", "$5", "Pay"]);
    // An amount over the cap isn't offered as a preset.
    const over = payActionMetadata(deps, { handle: "alex", name: null }, { amount: "500" }, entry);
    expect(over.links?.actions).toHaveLength(4);
  });
});

describe("Actions headers and actions.json", () => {
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
});

describe("pay action POST", () => {
  it("builds a devnet USDC transfer the payer signs: create ATA, transfer with the reference, memo", async () => {
    const { db, alex, deps } = await setup();
    const chain = fakeReader();
    const res = await preparePayment(deps, { entry, reader: chain.reader }, { handle: "alex", account: PAYER, amount: "5", note: "pizza" });
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

    const [aliceAta] = await findAssociatedTokenPda({ owner: ALEX_WALLET as never, mint: entry.mint as never, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [payerAta] = await findAssociatedTokenPda({ owner: PAYER as never, mint: entry.mint as never, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const c = parseCreateAssociatedTokenIdempotentInstruction(create as never);
    expect([c.accounts.payer.address, c.accounts.ata.address, c.accounts.owner.address, c.accounts.mint.address]).toEqual([
      PAYER,
      aliceAta,
      ALEX_WALLET,
      entry.mint,
    ]);
    const t = parseTransferCheckedInstruction({ ...transfer, accounts: transfer!.accounts!.slice(0, 4) } as never);
    expect(t.data.amount).toBe(5_000_000n);
    expect(t.data.decimals).toBe(6);
    expect([t.accounts.source.address, t.accounts.destination.address, t.accounts.authority.address]).toEqual([payerAta, aliceAta, PAYER]);
    // The reference rides on the transfer as a read-only, non-signing account.
    expect(transfer?.accounts?.[4]).toEqual({ address: res.reference, role: AccountRole.READONLY });
    expect(parseAddMemoInstruction(memo as never).data.memo).toBe(res.id);

    const [row] = await db.select().from(actionPayments).where(eq(actionPayments.id, res.id));
    expect(row).toMatchObject({
      reference: res.reference,
      recipientId: alex.id,
      recipientAddress: ALEX_WALLET,
      payerAddress: PAYER,
      amount: 5_000_000n,
      note: "pizza",
      signature: null,
    });
    expect((await getWallet(db, alex.id, "solana"))?.address).toBe(ALEX_WALLET);
  });

  it("refuses amounts outside $0.01 to the cap, bad accounts, unknown handles and thin wallets", async () => {
    const { deps } = await setup();
    const chain = { entry, reader: fakeReader().reader };
    const post = (input: { handle?: string; account?: unknown; amount?: string | null }) =>
      preparePayment(deps, chain, { handle: "alex", account: PAYER, amount: "5", ...input });

    for (const amount of ["0", "0.001", "50.01", "-1", "abc", null]) {
      expect(await post({ amount })).toEqual({ ok: false, status: 400, message: "Amounts can be from $0.01 to $50." });
    }
    expect((await post({ amount: "50" })).ok).toBe(true);
    expect((await post({ amount: "0.01" })).ok).toBe(true);
    expect(await post({ account: "not-an-address" })).toMatchObject({ ok: false, status: 400 });
    expect(await post({ account: 42 })).toMatchObject({ ok: false, status: 400 });
    expect(await post({ handle: "nobody" })).toEqual({ ok: false, status: 404, message: "No Dial user with that handle." });
    expect(await post({ account: ALEX_WALLET })).toMatchObject({ ok: false, status: 400, message: "That is @alex's own Dial wallet." });

    const thin = await preparePayment(deps, { entry, reader: fakeReader(2_000_000n).reader }, { handle: "alex", account: PAYER, amount: "5" });
    expect(thin).toEqual({ ok: false, status: 400, message: "This wallet has $2 in devnet USDC, not $5. Get test USDC at faucet.circle.com." });
    // A balance the RPC couldn't read doesn't block: the wallet's own simulation will.
    expect((await preparePayment(deps, { entry, reader: fakeReader(null).reader }, { handle: "alex", account: PAYER, amount: "5" })).ok).toBe(true);
  });

  it("caps how many unpaid transactions one handle can have out", async () => {
    const { deps } = await setup();
    const chain = { entry, reader: fakeReader().reader };
    for (let i = 0; i < MAX_OPEN_PER_HANDLE; i++) {
      expect((await preparePayment(deps, chain, { handle: "alex", account: PAYER, amount: "1" })).ok).toBe(true);
    }
    expect(await preparePayment(deps, chain, { handle: "alex", account: PAYER, amount: "1" })).toMatchObject({ ok: false, status: 429 });
  });
});

describe("reference matcher", () => {
  async function prepared(deps: BotDeps, chain: ReturnType<typeof fakeReader>, amount = "5") {
    const res = await preparePayment(deps, { entry, reader: chain.reader }, { handle: "alex", account: PAYER, amount, note: "pizza" });
    if (!res.ok) throw new Error(res.message);
    return res;
  }

  it("records a landed payment once, as from the paying wallet, and texts the recipient once", async () => {
    const { db, deps, sms } = await setup();
    const chain = fakeReader();
    const res = await prepared(deps, chain);
    const run = () => recordActionPayments(deps, { entry, reader: chain.reader });

    expect(await run()).toEqual({ recorded: 0, expired: 0, errors: 0 });
    chain.land(res.reference, "SigOne", 5_000_000n);
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
    const { deps, sms } = await setup();
    const chain = fakeReader();
    const one = await prepared(deps, chain);
    const two = await prepared(deps, chain);
    chain.land(one.reference, "SigShared", 5_000_000n);
    chain.land(two.reference, "SigShared", 5_000_000n);
    expect((await recordActionPayments(deps, { entry, reader: chain.reader })).recorded).toBe(1);
    expect(sms.to("+15550000010")).toHaveLength(1);
  });

  it("records what actually arrived, and skips failed transactions and transfers to someone else", async () => {
    const { db, deps } = await setup();
    const chain = fakeReader();
    const res = await prepared(deps, chain, "10");
    chain.land(res.reference, "SigFailed", 10_000_000n, { err: { InstructionError: [1, "Custom"] } });
    chain.land(res.reference, "SigElsewhere", 10_000_000n, { to: newReference() });
    expect((await recordActionPayments(deps, { entry, reader: chain.reader })).recorded).toBe(0);
    chain.land(res.reference, "SigLess", 3_000_000n);
    expect((await recordActionPayments(deps, { entry, reader: chain.reader })).recorded).toBe(1);
    const [row] = await db.select().from(actionPayments).where(eq(actionPayments.id, res.id));
    expect(row).toMatchObject({ signature: "SigLess", received: 3_000_000n, amount: 10_000_000n });
  });

  it("drops references that expired unpaid, but keeps them while the RPC is down", async () => {
    const { db, deps } = await setup();
    const chain = fakeReader();
    const res = await prepared(deps, chain);
    const later = { ...deps, now: () => new Date(now.getTime() + 31 * 60_000) };
    chain.setDown(true);
    expect(await recordActionPayments(later, { entry, reader: chain.reader })).toEqual({ recorded: 0, expired: 0, errors: 1 });
    expect(await db.select().from(actionPayments)).toHaveLength(1);
    chain.setDown(false);
    expect(await recordActionPayments(later, { entry, reader: chain.reader })).toEqual({ recorded: 0, expired: 1, errors: 0 });
    expect(await db.select().from(actionPayments).where(eq(actionPayments.id, res.id))).toHaveLength(0);

    // A day past expiry, an unpaid reference goes even while the RPC is down.
    await prepared(deps, chain);
    chain.setDown(true);
    const nextDay = { ...deps, now: () => new Date(now.getTime() + 25 * 60 * 60_000) };
    expect(await recordActionPayments(nextDay, { entry, reader: chain.reader })).toEqual({ recorded: 0, expired: 0, errors: 0 });
    expect(await db.select().from(actionPayments)).toHaveLength(0);
  });

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
    expect(paidTo({ ...tx, err: "boom" }, entry.mint, "Alex")).toBeNull();
  });
});

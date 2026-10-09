import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTool } from "@/lib/agents/tools";
import type { Agent } from "@/lib/agents/keys";
import { handleInbound } from "@/lib/bot/handle-inbound";
import { venueNamed } from "@/lib/bot/hyperliquid";
import { reconcileTransfers } from "@/lib/bot/settle";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { findUserByPhone } from "@/lib/identity";
import { getIntent } from "@/lib/intents";
import { publicStats, recentPayments } from "@/lib/stats";
import type { VenueTransfer } from "@/lib/settlement/capabilities";
import { TransferUnconfirmedError } from "@/lib/settlement/unconfirmed";
import type { InboundSms } from "@/lib/sms/inbound";
import { buildPaymentView } from "@/lib/views/payment";
import { getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const JEREMY = "+15550000011";
const NEWBIE = "+15550000099";

type Deposit = { to: string; amount: bigint; memo: string };
/** `closed`: addresses HyperCore has no account for. */
type FakeHyperCore = VenueTransfer & { deposits: Deposit[]; fail: { next: Error | null }; spot: Map<string, bigint>; closed: Set<string> };

function fakeHyperCore(): FakeHyperCore {
  const deposits: Deposit[] = [];
  const fail: FakeHyperCore["fail"] = { next: null };
  const spot = new Map<string, bigint>();
  const closed = new Set<string>();
  return {
    name: "HyperCore",
    deposits,
    fail,
    spot,
    closed,
    balance: async (address) => spot.get(address) ?? 0n,
    accepts: async (address) => !closed.has(address),
    deposit: async ({ to, amount, memo }) => {
      if (fail.next) {
        const e = fail.next;
        fail.next = null;
        throw e;
      }
      deposits.push({ to, amount, memo });
      // Like the registry's HyperEVM testnet entry: no public explorer shows it, so no link.
      return { txHash: `0xdep_${memo}`, explorerUrl: null };
    },
  };
}

/** Hyperliquid's info API: mainnet mids. */
function stubInfoApi(mids: Record<string, string>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(typeof init?.body === "string" ? init.body : "null") as Record<string, unknown> });
      return Response.json(mids);
    }),
  );
  return calls;
}

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let sol: FakeAdapter;
let hl: FakeAdapter;
let core: FakeHyperCore;
let k = 0;

const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `hl${++k}` });
const say = async (from: string, body: string) => {
  await handleInbound(deps, msg(from, body));
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";
const intentIdIn = (s: string) => /\/a\/(pi_[\w-]+)/.exec(s)?.[1] ?? "";

async function signUp(phone: string, name: string) {
  await say(phone, "hi");
  return say(phone, name);
}

async function hyperevmAddress(phone: string): Promise<string> {
  const u = await findUserByPhone(db, phone);
  return (await getWallet(db, u!.id, "hyperevm"))!.address;
}

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  sol = fakeAdapter({ defaultBalance: 100_000_000n });
  core = fakeHyperCore();
  hl = Object.assign(fakeAdapter({ chain: "hyperevm", defaultBalance: 100_000_000n }), { venue: core });
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: sol, hyperevm: hl } });
  await signUp(ALEX, "alex");
  await signUp(JEREMY, "jeremy");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("move $5 to hyperliquid", () => {
  it("asks for the code, then deposits into the sender's own HyperCore balance", async () => {
    const confirm = await say(ALEX, "move $5 to hyperliquid");
    expect(confirm).toMatch(/^Move \$5 USDC from HyperEVM to your Hyperliquid spot balance\? Reply \d{6} to confirm, or tap: https:\/\/tmc\.test\/a\/pi_/);
    expect(core.deposits).toHaveLength(0);

    await say(ALEX, codeIn(confirm));
    const mine = await hyperevmAddress(ALEX);
    const id = intentIdIn(confirm);
    expect(core.deposits).toEqual([{ to: mine, amount: 5_000_000n, memo: id }]);
    expect(hl.settled).toHaveLength(0);
    expect(sms.to(ALEX).slice(-2)).toEqual([
      "Sending $5 to your spot balance on Hyperliquid…",
      `Moved $5 to your Hyperliquid spot balance. Receipt: https://tmc.test/a/${id}`,
    ]);
    expect(await getIntent(db, id)).toMatchObject({ kind: "venue", status: "settled", chain: "hyperevm", recipientAddress: mine });
  });

  it("asking twice re-sends the same confirmation instead of a second deposit", async () => {
    const first = await say(ALEX, "move $5 to hyperliquid");
    const again = await say(ALEX, "move $5 to hyperliquid");
    expect(intentIdIn(again)).toBe(intentIdIn(first));
    await say(ALEX, codeIn(again));
    expect(core.deposits).toHaveLength(1);
  });

  it("checks the HyperEVM balance first", async () => {
    const short = Object.assign(fakeAdapter({ chain: "hyperevm", defaultBalance: 2_000_000n }), { venue: core });
    deps = { ...deps, adapters: { solana: sol, hyperevm: short } };
    expect(await say(ALEX, "move $5 to hyperliquid")).toBe(
      "You have $2 in test USDC, not enough for that one. Add more: https://tmc.test/@alex Free test USDC: faucet.circle.com",
    );
  });

  it("finds the venue by the word they used: its name, the chain's label or an alias", async () => {
    expect(venueNamed(deps.adapters, "hypercore")?.chain).toBe("hyperevm");
    expect(venueNamed(deps.adapters, "hyperliquid")?.chain).toBe("hyperevm");
    expect(venueNamed(deps.adapters, "hl")?.chain).toBe("hyperevm");
    expect(venueNamed(deps.adapters, "hyperevm")?.chain).toBe("hyperevm");
    expect(venueNamed(deps.adapters, "solana")).toBeNull();
    expect(await say(ALEX, "move $1 to hypercore")).toMatch(/^Move \$1 USDC from HyperEVM to your Hyperliquid spot balance\?/);
  });

  it("won't offer a deposit to an account HyperCore hasn't opened, since it would never be credited", async () => {
    const accepts = core.accepts;
    core.accepts = async () => false;
    expect(await say(ALEX, "move $5 to hyperliquid")).toBe(
      "Your Hyperliquid account isn't open yet, and a deposit from HyperEVM can't open one. Nothing moved.",
    );
    core.accepts = accepts;
    expect(await say(ALEX, "send @jeremy $5 to hyperliquid")).toMatch(/^Send \$5 USDC to @jeremy's Hyperliquid/);
    core.closed.add(await hyperevmAddress(JEREMY));
    expect(await say(ALEX, "send @jeremy $6 to hyperliquid")).toBe(
      "@jeremy's Hyperliquid account isn't open yet, and a deposit from HyperEVM can't open one. Nothing moved.",
    );
    expect(core.deposits).toHaveLength(0);
  });

  it("says so when deposits are off, and moves nothing", async () => {
    deps = { ...deps, adapters: { solana: sol, hyperevm: fakeAdapter({ chain: "hyperevm" }) } };
    expect(await say(ALEX, "move $5 to hyperliquid")).toBe("Hyperliquid transfers aren't switched on yet.");
  });

  it("doesn't call an unconfirmed deposit failed, and the reconciler sends the receipt once it lands", async () => {
    const confirm = await say(ALEX, "move $5 to hyperliquid");
    const id = intentIdIn(confirm);
    core.fail.next = new TransferUnconfirmedError("hyperevm", "0xslow", new Error("timeout"));
    await say(ALEX, codeIn(confirm));
    expect(sms.last(ALEX)).toBe(
      "Your $5 to your Hyperliquid balance is taking longer than usual to confirm. I'll text you as soon as it does, so don't send it again.",
    );
    expect((await getIntent(db, id))?.status).toBe("settling");

    // The chain says it landed; HyperEVM testnet has no explorer, so the receipt is Dial's own page.
    hl.transferOutcome = async (txHash) => ({ state: "landed", result: { txHash, explorerUrl: null } });
    expect(await reconcileTransfers(deps)).toEqual({ settled: 1, failed: 0 });
    expect(sms.last(ALEX)).toBe(`Moved $5 to your Hyperliquid spot balance. Receipt: https://tmc.test/a/${id}`);
    expect(await getIntent(db, id)).toMatchObject({ status: "settled", txHash: "0xslow" });
  });

  it("marks a deposit that reverted as failed", async () => {
    const confirm = await say(ALEX, "move $5 to hyperliquid");
    core.fail.next = new Error("hyperevm tx 0xbad reverted");
    await say(ALEX, codeIn(confirm));
    expect(sms.last(ALEX)).toBe("That payment didn't go through. No funds moved.");
    expect((await getIntent(db, intentIdIn(confirm)))?.status).toBe("failed");
  });
});

describe("send @jeremy $5 to hyperliquid", () => {
  it("deposits into the recipient's HyperCore account, their Dial HyperEVM address, and tells them", async () => {
    const confirm = await say(ALEX, "send @jeremy $5 to hyperliquid");
    expect(confirm).toMatch(/^Send \$5 USDC to @jeremy's Hyperliquid spot balance\? Reply \d{6}/);
    await say(ALEX, codeIn(confirm));
    const id = intentIdIn(confirm);
    expect(core.deposits).toEqual([{ to: await hyperevmAddress(JEREMY), amount: 5_000_000n, memo: id }]);
    expect(sms.last(ALEX)).toBe(`Sent $5 to jeremy on Hyperliquid. Receipt: https://tmc.test/a/${id}`);
    expect(sms.last(JEREMY)).toBe(
      `jeremy, alex sent $5 to your Hyperliquid spot balance. Text "hl balance" to see it. Receipt: https://tmc.test/a/${id}`,
    );
  });

  it("won't send to someone who isn't on Dial, and creates nothing", async () => {
    expect(await say(ALEX, "send +1 555 000 0099 $5 to hyperliquid")).toBe(
      "+•••••••0099 isn't on Dial yet, so there's no Hyperliquid balance to send to. Send it to them normally instead.",
    );
    expect(core.deposits).toHaveLength(0);
    expect(sms.to(NEWBIE)).toHaveLength(0);
  });

  it("asks for an @handle when the name is unknown", async () => {
    expect(await say(ALEX, "send sam $5 to hyperliquid")).toBe(
      `Which "sam"? Use their Dial @handle, like "send @alex $5 to hyperliquid".`,
    );
  });

  it("shows on the public ledger as a Hyperliquid payment with its receipt", async () => {
    const confirm = await say(ALEX, "send @jeremy $5 to hyperliquid");
    await say(ALEX, codeIn(confirm));
    const id = intentIdIn(confirm);
    const [row] = await recentPayments(db, 10);
    expect(row).toMatchObject({
      id,
      kind: "venue",
      from: "@alex",
      to: "@jeremy",
      txHash: `0xdep_${id}`,
      explorerUrl: null,
    });
    expect((await publicStats(db)).payments).toBe(1);
    const view = await buildPaymentView(db, (await getIntent(db, id))!, deps.now(), { network: "testnet", audience: "public" });
    expect(view).toMatchObject({ kindLabel: "HyperCore deposit", network: "HyperEVM testnet → HyperCore testnet" });
  });
});

describe("hl balance and price", () => {
  it("reads the venue balance of the user's HyperEVM address", async () => {
    await say(ALEX, "move $5 to hyperliquid");
    core.spot.set(await hyperevmAddress(ALEX), 5_000_000n);
    expect(await say(ALEX, "hl balance")).toBe("You have $5 USDC in your Hyperliquid spot balance (HyperCore testnet).");
  });

  it("says so when no chain carries a venue", async () => {
    deps = { ...deps, adapters: { solana: sol } };
    expect(await say(ALEX, "hl balance")).toBe("Hyperliquid transfers aren't switched on yet.");
  });

  it("says how to start when there's no HyperEVM wallet yet", async () => {
    expect(await say(JEREMY, "hl balance")).toBe(`You don't have a Hyperliquid balance yet. Text "move $5 to hyperliquid" to start one.`);
  });

  it("quotes the Hyperliquid mainnet mid, labelled, and works with HyperEVM off", async () => {
    deps = { ...deps, adapters: { solana: sol } };
    const calls = stubInfoApi({ BTC: "82355.5", HYPE: "85.2835" });
    expect(await say(ALEX, "price BTC")).toBe("BTC is $82,355.50, the Hyperliquid mainnet mid. A quote, not advice.");
    expect(await say(ALEX, "price hype")).toBe("HYPE is $85.28, the Hyperliquid mainnet mid. A quote, not advice.");
    expect(await say(ALEX, "price nope")).toBe(`Hyperliquid has no NOPE market. Try "price BTC" or "price HYPE".`);
    expect(calls.every((c) => c.url === "https://api.hyperliquid.xyz/info")).toBe(true);
  });

  it("says Hyperliquid isn't answering when the info API is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    expect(await say(ALEX, "price BTC")).toBe("The HyperEVM network isn't answering right now. Nothing moved. Try again in a minute.");
  });
});

describe("MCP tools", () => {
  async function agentFor(phone: string): Promise<Agent> {
    const user = (await findUserByPhone(db, phone))!;
    return {
      user,
      key: { id: "ak_test", userId: user.id, keyHash: "h", label: "claude", createdAt: deps.now(), lastUsedAt: null, revokedAt: null },
    };
  }

  it("send_to_hyperliquid starts a deposit the owner approves by text, never handing the agent a code", async () => {
    const agent = await agentFor(ALEX);
    const r = await runTool(deps, agent, "send_to_hyperliquid", { amountUsd: "5", to: "@jeremy" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ status: "awaiting_approval", kind: "venue", amountUsd: "5", chain: "hyperevm", approver: "you" });
    expect(JSON.stringify(r.data)).not.toMatch(/\b\d{6}\b/);
    expect(sms.last(ALEX)).toMatch(/^From your agent "claude": Send \$5 USDC to @jeremy's Hyperliquid spot balance\? Reply \d{6}/);

    const again = await runTool(deps, agent, "send_to_hyperliquid", { amountUsd: "5", to: "@jeremy" });
    expect(again).toMatchObject({ ok: false, error: { error: "duplicate" } });

    await say(ALEX, codeIn(sms.to(ALEX).find((b) => b.startsWith("From your agent"))!));
    expect(core.deposits).toHaveLength(1);
    const got = await runTool(deps, agent, "get_payment", { intentId: String(r.data.intentId) });
    expect(got).toMatchObject({ ok: true, data: { status: "settled", kind: "venue", network: "HyperEVM testnet → HyperCore testnet" } });
  });

  it("send_to_hyperliquid with no recipient is the owner's own balance", async () => {
    const r = await runTool(deps, await agentFor(ALEX), "send_to_hyperliquid", { amountUsd: "2" });
    expect(r).toMatchObject({ ok: true, data: { kind: "venue", approver: "you" } });
    expect(sms.last(ALEX)).toMatch(/Move \$2 USDC from HyperEVM to your Hyperliquid spot balance\?/);
  });

  it("refuses people who aren't on Dial", async () => {
    const r = await runTool(deps, await agentFor(ALEX), "send_to_hyperliquid", { amountUsd: "2", to: NEWBIE });
    expect(r).toMatchObject({ ok: false, error: { error: "unknown_recipient" } });
  });

  it("get_hyperliquid_balance and get_price read Hyperliquid's info API", async () => {
    await say(ALEX, "move $1 to hyperliquid");
    const agent = await agentFor(ALEX);
    core.spot.set(await hyperevmAddress(ALEX), 1_500_000n);
    stubInfoApi({ HYPE: "85.2835" });
    expect(await runTool(deps, agent, "get_hyperliquid_balance", {})).toEqual({
      ok: true,
      data: { account: await hyperevmAddress(ALEX), network: "HyperCore testnet", amountUsd: "1.50", asset: "USDC", balance: "HyperCore spot" },
    });
    expect(await runTool(deps, agent, "get_price", { coin: "hype" })).toMatchObject({
      ok: true,
      data: { coin: "HYPE", mid: "85.2835", source: "Hyperliquid mainnet mid (info API allMids)" },
    });
    expect(await runTool(deps, agent, "get_price", { coin: "NOPE" })).toMatchObject({ ok: false, error: { error: "not_found" } });
  });
});

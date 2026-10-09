import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { authenticateAgent, redeemAgentLink } from "@/lib/agents/keys";
import { runTool } from "@/lib/agents/tools";
import { handleInbound } from "@/lib/bot/handle-inbound";
import { approveIntent } from "@/lib/bot/settle";
import { splitShares } from "@/lib/bot/split";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { intents } from "@/lib/db/schema";
import { findUserByPhone } from "@/lib/identity";
import { matchPageCode, splitLegs } from "@/lib/intents";
import type { TransferLeg as BatchLeg } from "@/lib/settlement/capabilities";
import { getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const JEREMY = "+15550000011";
const ALEX = "+15550000010";
const SAM = "+15550000012";
const NEWBIE = "+15550000099";
const TX = { txHash: "0xsplit", explorerUrl: "https://explore.test/tx/0xsplit" };

type FakeTempo = FakeAdapter & { batches: BatchLeg[][]; failNext: Error | null };

/** A Tempo adapter that records each batch it would send as one transaction. */
function fakeTempo(): FakeTempo {
  const base = fakeAdapter({ chain: "tempo", defaultBalance: 100_000_000n });
  const t: FakeTempo = Object.assign(base, {
    batches: [] as BatchLeg[][],
    failNext: null as Error | null,
    batch: {
      maxLegs: 16,
      settleBatch: async ({ legs }: { legs: BatchLeg[] }) => {
        if (t.failNext) {
          const e = t.failNext;
          t.failNext = null;
          throw e;
        }
        t.batches.push([...legs]);
        return TX;
      },
    },
  });
  return t;
}

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let tempo: FakeTempo;
let k = 0;

const say = async (from: string, body: string) => {
  await handleInbound(deps, { to: "+18066071387", from, body, dedupeKey: `k${++k}` });
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";

async function signUp(phone: string, name: string) {
  await say(phone, "hi");
  await say(phone, name);
}

async function legsOf(phone: string) {
  const u = await findUserByPhone(db, phone);
  const [leg] = await db.select().from(intents).where(eq(intents.senderId, u!.id));
  return leg?.splitId ? splitLegs(db, leg.splitId) : [];
}

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  tempo = fakeTempo();
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }), tempo } });
  await signUp(JEREMY, "Jeremy");
  await signUp(ALEX, "Alex");
  await signUp(SAM, "Sam");
});

describe("split shares", () => {
  it("divides to the cent and gives the leftover cent to the first person", () => {
    expect(splitShares(30_000_000n, 3)).toEqual([10_000_000n, 10_000_000n, 10_000_000n]);
    expect(splitShares(10_000_000n, 3)).toEqual([3_340_000n, 3_330_000n, 3_330_000n]);
    expect(splitShares(50_000n, 2)).toEqual([30_000n, 20_000n]);
    expect(splitShares(10_000n, 1)).toEqual([10_000n]);
  });

  it("refuses shares under a cent", () => {
    expect(splitShares(20_000n, 3)).toBeNull();
    expect(splitShares(10_000_000n, 0)).toBeNull();
  });
});

describe("split over SMS", () => {
  it("one code approves every share, and they settle in one transaction with a memo per leg", async () => {
    const confirm = await say(JEREMY, "split $30 between @alex @sam for dinner on tempo");
    const legs = await legsOf(JEREMY);
    expect(confirm).toBe(
      `Split $30 (dinner) 2 ways on Tempo: $15 each to @alex, @sam. Reply ${codeIn(confirm)} to confirm, or tap: https://tmc.test/a/${legs[0]!.id}`,
    );
    expect(legs.map((l) => [l.kind, l.amount, l.status, l.note])).toEqual([
      ["send", 15_000_000n, "pending", "dinner"],
      ["send", 15_000_000n, "pending", "dinner"],
    ]);
    expect(new Set(legs.map((l) => l.splitId)).size).toBe(1);

    await say(JEREMY, codeIn(confirm));
    expect(tempo.batches).toHaveLength(1);
    const alex = await findUserByPhone(db, ALEX);
    const sam = await findUserByPhone(db, SAM);
    expect(tempo.batches[0]).toEqual([
      { to: (await getWallet(db, alex!.id, "tempo"))!.address, amount: 15_000_000n, memo: legs[0]!.id },
      { to: (await getWallet(db, sam!.id, "tempo"))!.address, amount: 15_000_000n, memo: legs[1]!.id },
    ]);
    // Nothing went out one leg at a time.
    expect(tempo.settled).toHaveLength(0);

    const after = await legsOf(JEREMY);
    expect(after.map((l) => [l.status, l.txHash])).toEqual([
      ["settled", "0xsplit"],
      ["settled", "0xsplit"],
    ]);
    expect(sms.to(JEREMY).slice(-2)).toEqual([
      "Sending your $30 split to 2 people on Tempo…",
      "Split sent on Tempo in one transaction: $15 each to @alex, @sam. Receipt: https://explore.test/tx/0xsplit",
    ]);
    expect(sms.last(ALEX)).toBe("Alex, you got $15 from Jeremy (dinner) on Tempo. Receipt: https://explore.test/tx/0xsplit");
    expect(sms.last(SAM)).toBe("Sam, you got $15 from Jeremy (dinner) on Tempo. Receipt: https://explore.test/tx/0xsplit");
  });

  it("'with' includes the sender, who pays everyone else's share", async () => {
    const confirm = await say(JEREMY, "split $30 with @alex @sam on tempo");
    expect(confirm).toMatch(/^Split \$30 3 ways on Tempo: \$10 each to @alex, @sam, and \$10 is your share\. Reply \d{6}/);
    await say(JEREMY, codeIn(confirm));
    expect(tempo.batches[0]!.map((l) => l.amount)).toEqual([10_000_000n, 10_000_000n]);
  });

  it("gives the leftover cent to the first person listed", async () => {
    const confirm = await say(JEREMY, "split $10 between @alex, @sam and me on tempo");
    expect(confirm).toMatch(/^Split \$10 3 ways on Tempo: @alex \$3\.34, @sam \$3\.33, and \$3\.33 is your share\./);
    await say(JEREMY, codeIn(confirm));
    expect(tempo.batches[0]!.map((l) => l.amount)).toEqual([3_340_000n, 3_330_000n]);
  });

  it("runs where transactions batch: a chain that can't is pointed at 'on tempo' and nothing is created", async () => {
    expect(await say(JEREMY, "split $30 between @alex @sam on solana")).toBe(
      'Splits settle in one transaction on Tempo, so they run there, not on Solana. Add "on tempo" to the end and text it again.',
    );
    expect(await legsOf(JEREMY)).toEqual([]);
  });

  it("picks the chain that batches when none is named, even with another default", async () => {
    // Jeremy's default chain is Solana, which can't batch.
    expect(await say(JEREMY, "split $30 between @alex @sam")).toMatch(/^Split \$30 2 ways on Tempo: \$15 each to @alex, @sam\./);
  });

  it("says splits are off when no chain batches", async () => {
    delete (tempo as Partial<FakeTempo>).batch;
    expect(await say(JEREMY, "split $30 between @alex @sam on tempo")).toBe("Splits aren't switched on yet. Send each person a payment instead.");
  });

  it("applies the per-payment cap to each share and the daily cap and balance to the total", async () => {
    // $120 two ways is $60 a share, over the $50 cap.
    expect(await say(JEREMY, "split $120 between @alex @sam on tempo")).toBe("Test mode caps payments at $50. Try a smaller amount.");
    // $90 two ways is $45 a share: fine per payment, but over a $80 day.
    deps = { ...deps, perDayCap: 80_000_000n };
    expect(await say(JEREMY, "split $90 between @alex @sam on tempo")).toBe(
      'Text-only accounts can send $80 a day. Text "upgrade" to add a passkey for higher limits.',
    );
    deps = { ...deps, perDayCap: 200_000_000n };
    const jeremy = await findUserByPhone(db, JEREMY);
    tempo.balances.set((await getWallet(db, jeremy!.id, "tempo"))!.address, 50_000_000n);
    expect(await say(JEREMY, "split $90 between @alex @sam on tempo")).toMatch(/^You have \$50 in test USDC, not enough for that one\./);
    expect(await legsOf(JEREMY)).toEqual([]);
  });

  it("stops at 10 people and needs at least two", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `+1555000${String(2000 + i)}`).join(", ");
    expect(await say(JEREMY, `split $50 between ${eleven} on tempo`)).toBe("Splits can have up to 10 people, you included. Try fewer.");
    expect(await say(JEREMY, "split $10 between @alex on tempo")).toMatch(/^A split needs at least two people\./);
    expect(await say(JEREMY, "split $0.02 between @alex @sam me on tempo")).toBe(
      "$0.02 can't be split 3 ways to the cent. Try a bigger amount.",
    );
    expect(await say(JEREMY, "split $10 between @alex @nobody on tempo")).toBe(
      "There's no Dial user called @nobody. Send their phone number instead.",
    );
    expect(await say(JEREMY, "split $10 between @alex @jeremy on tempo")).toBe("That's you. Pick someone else.");
  });

  it("is all or nothing: a transaction that fails leaves every leg failed and pays nobody", async () => {
    const confirm = await say(JEREMY, "split $30 between @alex @sam on tempo");
    const alexBefore = sms.to(ALEX).length;
    tempo.failNext = new Error("tempo tx 0xdead reverted");
    await say(JEREMY, codeIn(confirm));
    expect((await legsOf(JEREMY)).map((l) => [l.status, l.txHash])).toEqual([
      ["failed", null],
      ["failed", null],
    ]);
    expect(sms.last(JEREMY)).toBe("That payment didn't go through. No funds moved.");
    expect(sms.to(ALEX)).toHaveLength(alexBefore);
    // The code is spent: replaying it approves nothing.
    expect(await say(JEREMY, codeIn(confirm))).not.toMatch(/Split sent/);
    expect(tempo.batches).toHaveLength(0);
  });

  it("checks the balance again at approval and moves nothing when it's short", async () => {
    const confirm = await say(JEREMY, "split $30 between @alex @sam on tempo");
    const jeremy = await findUserByPhone(db, JEREMY);
    tempo.balances.set((await getWallet(db, jeremy!.id, "tempo"))!.address, 20_000_000n);
    await say(JEREMY, codeIn(confirm));
    expect(sms.last(JEREMY)).toBe("You only have $20 now, so I didn't send it. Nothing moved.");
    expect((await legsOf(JEREMY)).every((l) => l.status === "failed")).toBe(true);
    expect(tempo.batches).toHaveLength(0);
  });

  it("holds a newcomer's share in the same transaction for them to claim", async () => {
    const confirm = await say(JEREMY, "split $20 between @alex and +1 555 000 0099 on tempo");
    expect(confirm).toMatch(/^Split \$20 2 ways on Tempo: \$10 each to @alex, \+•+0099\. Reply \d{6}/);
    await say(JEREMY, codeIn(confirm));
    const legs = await legsOf(JEREMY);
    expect(legs.map((l) => l.status)).toEqual(["settled", "escrowed"]);
    expect(legs[1]!.escrowSecretEnc).not.toBeNull();
    expect(tempo.batches[0]![1]).toEqual({ to: legs[1]!.recipientAddress, amount: 10_000_000n, memo: legs[1]!.id });
    expect(sms.last(JEREMY)).toMatch(
      /^Split sent on Tempo in one transaction: \$10 each to @alex, \+•+0099\. \+•+0099 has 7 days to claim\. Receipt: /,
    );
    expect(sms.last(NEWBIE)).toMatch(/^Jeremy sent you \$10 USDC on Dial\. Reply to this text to claim it\./);

    // They sign up and claim it the usual way: out of the held wallet, to their own.
    await say(NEWBIE, "hi");
    const offer = await say(NEWBIE, "Nina");
    await say(NEWBIE, codeIn(offer || sms.to(NEWBIE).find((s) => /Reply \d{6} to claim/.test(s)) || ""));
    expect((await legsOf(JEREMY))[1]!.status).toBe("settled");
    expect(tempo.settled.at(-1)).toMatchObject({ amount: 10_000_000n, memo: legs[1]!.id });
  });

  it("status shows the whole split and its fresh code approves all of it", async () => {
    await say(JEREMY, "split $30 between @alex @sam on tempo");
    const status = await say(JEREMY, "status");
    expect(status).toMatch(/^Still waiting on you: your \$30 split, \$15 each to @alex, @sam\. New code: reply (\d{6}) to confirm/);
    await say(JEREMY, codeIn(status));
    expect(tempo.batches).toHaveLength(1);
    expect(await say(JEREMY, "status")).toBe(
      "Yes, your split went through: $15 each to @alex, @sam. Receipt: https://explore.test/tx/0xsplit",
    );
  });

  it("nevermind cancels every share", async () => {
    await say(JEREMY, "split $30 between @alex @sam on tempo");
    expect(await say(JEREMY, "nevermind")).toBe("OK, cancelled. Nothing was sent.");
    expect((await legsOf(JEREMY)).map((l) => l.status)).toEqual(["declined", "declined"]);
  });

  it("approving any leg from the web approves the split once", async () => {
    await say(JEREMY, "split $30 between @alex @sam on tempo");
    const legs = await legsOf(JEREMY);
    expect((await approveIntent(deps, legs[1]!.id)).ok).toBe(true);
    expect(await approveIntent(deps, legs[0]!.id)).toEqual({ ok: false, reason: "not_claimable" });
    expect(tempo.batches).toHaveLength(1);
  });

  it("a wrong code on any leg's page costs every leg a try: five in all, not five per leg", async () => {
    const confirm = await say(JEREMY, "split $30 between @alex @sam on tempo");
    const right = codeIn(confirm);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let n = 0; n < 5; n++) {
      const legs = await legsOf(JEREMY);
      expect(await matchPageCode(db, legs[n % 2]!, wrong)).toBe(false);
    }
    expect((await legsOf(JEREMY)).map((l) => l.codeAttempts)).toEqual([5, 5]);
    expect(await matchPageCode(db, (await legsOf(JEREMY))[1]!, right)).toBe(false);
    expect(tempo.batches).toHaveLength(0);
  });

  it("a send of the same amount isn't mistaken for a share of a pending split", async () => {
    await say(JEREMY, "split $30 between @alex @sam on tempo");
    expect(await say(JEREMY, "send @alex $15 on tempo")).toMatch(/^Send \$15 USDC to @alex on Tempo\?/);
  });
});

describe("split_payment over MCP", () => {
  async function agent() {
    const reply = await say(JEREMY, "connect agent");
    const token = /\/k\/([\w-]+)/.exec(reply)?.[1] ?? "";
    const r = await redeemAgentLink(db, token, codeIn(reply), deps.now());
    if (!r.ok) throw new Error(r.reason);
    const a = await authenticateAgent(db, `Bearer ${r.key}`, deps.now());
    if (!a) throw new Error("no agent");
    return a;
  }

  it("creates the legs, texts the owner one code, and settles them together once approved", async () => {
    const a = await agent();
    const r = await runTool(deps, a, "split_payment", { amountUsd: "30", people: ["@alex", "@sam"], includeMe: true, note: "cab" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      status: "awaiting_approval",
      chain: "tempo",
      amountUsd: "30",
      paysUsd: "20",
      ownShareUsd: "10",
      legs: [
        { to: "@alex", amountUsd: "10", onDial: true },
        { to: "@sam", amountUsd: "10", onDial: true },
      ],
    });
    const text = sms.last(JEREMY);
    expect(text).toMatch(/^From your agent "[^"]+": Split \$30 \(cab\) 3 ways on Tempo: \$10 each to @alex, @sam, and \$10 is your share\./);
    await say(JEREMY, codeIn(text));
    expect(tempo.batches).toHaveLength(1);
    const legs = r.data.legs as Array<{ intentId: string }>;
    const got = await runTool(deps, a, "get_payment", { intentId: legs[1]!.intentId });
    expect(got.ok && got.data).toMatchObject({ status: "settled", to: "Sam", txHash: "0xsplit", splitId: r.data.splitId });
  });

  it("refuses other chains and more than 10 people, with the same rules as SMS", async () => {
    const a = await agent();
    expect(await runTool(deps, a, "split_payment", { amountUsd: "30", people: ["@alex", "@sam"], chain: "base" })).toEqual({
      ok: false,
      error: {
        error: "split_chain",
        message: "Splits settle in one transaction, which Base can't do. Leave chain out to use one that can (see list_chain_features).",
      },
    });
    const ten = Array.from({ length: 10 }, (_, i) => `+1555000${String(3000 + i)}`);
    expect(await runTool(deps, a, "split_payment", { amountUsd: "50", people: ten, includeMe: true })).toMatchObject({
      ok: false,
      error: { error: "split_people" },
    });
    expect(await runTool(deps, a, "split_payment", { amountUsd: "120", people: ["@alex", "@sam"] })).toMatchObject({
      ok: false,
      error: { error: "over_cap" },
    });
  });
});

describe("split on the receipt page and the ledger", () => {
  it("/a/<id> shows every leg and the split's total; the ledger folds the legs into one entry", async () => {
    const { buildPaymentView } = await import("@/lib/views/payment");
    const { groupSplits, recentPayments } = await import("@/lib/stats");
    const confirm = await say(JEREMY, "split $10 between @alex, @sam and me on tempo");
    await say(JEREMY, codeIn(confirm));
    const legs = await legsOf(JEREMY);

    const view = await buildPaymentView(db, legs[1]!, deps.now(), { network: "testnet", audience: "public" });
    expect(view).toMatchObject({
      kindLabel: "Split",
      to: "2 people",
      amount: 6_670_000n,
      funding: { hash: "0xsplit" },
      split: {
        legs: [
          { id: legs[0]!.id, to: "@alex", amount: 3_340_000n },
          { id: legs[1]!.id, to: "@sam", amount: 3_330_000n },
        ],
      },
    });

    const feed = groupSplits(await recentPayments(db, 20));
    const split = feed.filter((f) => f.splitId);
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({
      from: "@jeremy",
      to: "@alex, @sam",
      amount: 6_670_000n,
      txHash: "0xsplit",
      legs: [
        { to: "@alex", amount: 3_340_000n },
        { to: "@sam", amount: 3_330_000n },
      ],
    });
  });
});

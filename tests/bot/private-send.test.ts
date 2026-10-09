import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { getIntent } from "@/lib/intents";
import { interpret, type LlmInterpreter } from "@/lib/operator/brain";
import { parseCommand } from "@/lib/operator/grammar";
import type { InboundSms } from "@/lib/sms/inbound";
import { type FeedItem, groupSplits, publicStats, recentPayments } from "@/lib/stats";
import { buildPaymentView } from "@/lib/views/payment";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000030";
const JEREMY = "+15550000031";

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let sol: FakeAdapter;
let zec: FakeAdapter;
let k = 0;

const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `p${++k}` });
const say = async (from: string, body: string) => {
  await handleInbound(deps, msg(from, body));
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";
const intentIdIn = (s: string) => /\/a\/(pi_[\w-]+)/.exec(s)?.[1] ?? "";

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  sol = fakeAdapter({ defaultBalance: 100_000_000n });
  zec = { ...fakeAdapter({ chain: "zcash", defaultBalance: 5_000_000n }), shielded: { pool: "Ironwood", byDefault: true } };
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: sol, zcash: zec } });
  for (const [phone, name] of [
    [ALEX, "Alex"],
    [JEREMY, "Jeremy"],
  ] as const) {
    await say(phone, "hi");
    await say(phone, name);
  }
});

describe("parsing a private send", () => {
  it("reads every way of asking", () => {
    const want = { kind: "send", counterparty: "@alex", amountUsd: "5", private: true };
    expect(parseCommand("send @alex $5 privately")).toEqual(want);
    expect(parseCommand("privately send @alex $5")).toEqual(want);
    expect(parseCommand("send privately @alex $5")).toEqual(want);
    expect(parseCommand("send @alex $5 private")).toEqual(want);
    expect(parseCommand("Send @alex $5 privately for pizza")).toEqual({ ...want, note: "pizza" });
    expect(parseCommand("send @alex $5 for pizza privately")).toEqual({ ...want, note: "pizza" });
  });

  it("leaves a note about private things alone, and doesn't make requests private", () => {
    expect(parseCommand("send @alex $5 for private lessons")).toEqual({
      kind: "send",
      counterparty: "@alex",
      amountUsd: "5",
      note: "private lessons",
    });
    expect(parseCommand("request $5 from @alex privately")).toEqual({ kind: "chat" });
  });

  it("takes private from the plain-English reader too, for sends only", async () => {
    const llm: LlmInterpreter = async () => ({
      intent: "send",
      counterparty: "alex",
      amountUsd: "5",
      chain: null,
      note: null,
      private: true,
      reply: "",
    });
    const turn = await interpret("pay alex five bucks on the down low", llm);
    expect(turn.command).toMatchObject({ kind: "send", private: true });
  });
});

describe("sending privately by text", () => {
  it("goes shielded over Zcash whatever the default chain, and says so", async () => {
    const confirm = await say(ALEX, "send @jeremy $1 privately");
    expect(confirm).toMatch(/^Send \$1 \(0\.02 TAZ\) to @jeremy privately\? It goes shielded on Zcash \(Ironwood pool\)/);
    expect(confirm).toContain("encrypted memo");
    const id = intentIdIn(confirm);
    expect(await getIntent(db, id)).toMatchObject({ chain: "zcash", private: true });

    await say(ALEX, codeIn(confirm));
    expect(sol.settled).toHaveLength(0);
    expect(zec.settled).toHaveLength(1);
    expect(zec.settled[0]?.memo).toBe(id);
    expect(sms.to(ALEX).some((t) => /^Sent \$1 \(0\.02 TAZ\) to Jeremy on Zcash \(shielded\)/.test(t))).toBe(true);
  });

  it("says private sends aren't on when no switched-on chain can shield", async () => {
    deps = { ...deps, adapters: { solana: sol } };
    expect(await say(ALEX, "send @jeremy $1 privately")).toBe(
      `Private sends need a chain with a shielded pool, and none is switched on yet. Send without "privately" to use your usual chain.`,
    );
  });

  it("won't send privately on a chain that can't", async () => {
    expect(await say(ALEX, "send @jeremy $1 privately on solana")).toBe(
      `Solana can't shield a payment. Leave out "on solana" and I'll send it privately on Zcash.`,
    );
  });

  it("finds the chain by its shielded module, never by name", async () => {
    // A made-up shielded chain: no Zcash at all, and the private send still finds where to go.
    const tempo = { ...fakeAdapter({ chain: "tempo", defaultBalance: 5_000_000n }), shielded: { pool: "Test", byDefault: false } };
    deps = { ...deps, adapters: { solana: sol, tempo } };
    const confirm = await say(ALEX, "send @jeremy $1 privately");
    expect(confirm).toContain("privately? It goes shielded on Tempo (Test pool)");
    expect(await getIntent(db, intentIdIn(confirm))).toMatchObject({ chain: "tempo", private: true });
  });
});

describe("what the public sees of a private send", () => {
  async function settledPrivate(): Promise<string> {
    const confirm = await say(ALEX, "send @jeremy $1 privately for rent");
    await say(ALEX, codeIn(confirm));
    return intentIdIn(confirm);
  }

  it("the receipt and its card say shielded and show no amount, names or note", async () => {
    const intent = await getIntent(db, await settledPrivate());
    if (!intent) throw new Error("no intent");
    for (const audience of ["public", "card"] as const) {
      const v = await buildPaymentView(db, intent, deps.now(), { network: "testnet", audience });
      expect(v).toMatchObject({ shielded: true, amount: null, from: "someone", to: "someone", note: null, kindLabel: "Shielded payment" });
      expect(v.funding?.hash).toBeTruthy(); // the txid is public on Zcash anyway
    }
    const owner = await buildPaymentView(db, intent, deps.now(), { network: "testnet", audience: "party" });
    expect(owner).toMatchObject({ amount: 1_000_000n, note: "rent", shielded: true });
  });

  it("the ledger lists it as shielded and leaves it out of the dollars moved", async () => {
    const before = await publicStats(db);
    await settledPrivate();
    const [row] = await recentPayments(db, 5);
    expect(row).toMatchObject({ amount: null, from: "someone", to: "someone", chain: "zcash" });
    const after = await publicStats(db);
    expect(after.payments).toBe(before.payments + 1);
    expect(after.movedUsd).toBe(before.movedUsd);
  });

  it("sits next to a split in the feed without mixing: the split folds its legs, the private send stays hidden", () => {
    const at = new Date("2026-10-09T12:00:00Z");
    const base = { chain: "tempo" as const, status: "settled" as const, txHash: "0xabc", explorerUrl: null, at };
    const items: FeedItem[] = [
      { ...base, id: "pi_leg2", from: "@alex", to: "@sam", amount: 2_000_000n, splitId: "sp_1" },
      { ...base, id: "pi_priv", chain: "zcash", from: "someone", to: "someone", amount: null, splitId: null },
      { ...base, id: "pi_leg1", from: "@alex", to: "@jeremy", amount: 3_000_000n, splitId: "sp_1" },
    ];
    const [split, shielded] = groupSplits(items);
    expect(split).toMatchObject({ amount: 5_000_000n, to: "@jeremy, @sam", legs: [{ to: "@jeremy" }, { to: "@sam" }] });
    expect(shielded).toMatchObject({ id: "pi_priv", amount: null, legs: null, from: "someone", to: "someone" });
  });
});

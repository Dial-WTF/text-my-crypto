import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { getIntent } from "@/lib/intents";
import type { TransferLeg } from "@/lib/settlement/capabilities";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const JEREMY = "+15550000011";
const BOB = "+15550000012";
const CAP = 15_000_000n;

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let sol: FakeAdapter;
let batches: TransferLeg[][];
let clock: Date;
let k = 0;

const say = async (from: string, body: string) => {
  await handleInbound(deps, { to: "+18066071387", from, body, dedupeKey: `d${++k}` });
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";
const intentIdIn = (s: string) => /\/a\/(pi_[\w-]+)/.exec(s)?.[1] ?? "";
const paidOut = () => sol.settled.reduce((sum, s) => sum + s.amount, 0n) + batches.flat().reduce((sum, l) => sum + l.amount, 0n);
const overDaily = "Text-only accounts can send $15 a day. Text \"upgrade\" to add a passkey for higher limits.";

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  batches = [];
  clock = new Date("2026-10-09T12:00:00Z");
  sol = fakeAdapter({ defaultBalance: 100_000_000n });
  const tempo = Object.assign(fakeAdapter({ chain: "tempo", defaultBalance: 100_000_000n }), {
    batch: {
      maxLegs: 16,
      settleBatch: async ({ legs }: { legs: TransferLeg[] }) => {
        batches.push(legs);
        return { txHash: "0xsplit", explorerUrl: "https://explore.test/tx/0xsplit" };
      },
    },
  });
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: sol, tempo }, now: () => clock });
  for (const [phone, name] of [
    [ALEX, "alex"],
    [JEREMY, "jeremy"],
    [BOB, "bob"],
  ] as const) {
    await say(phone, "hi");
    await say(phone, `call me ${name}`);
  }
  deps = { ...deps, perDayCap: CAP };
});

describe("the daily cap holds at approval, not only when a payment is asked for", () => {
  it("two payments waiting side by side can't both be approved past it", async () => {
    const first = await say(ALEX, "send @jeremy $10");
    const second = await say(ALEX, "send @bob $10");
    await say(ALEX, codeIn(first));
    await say(ALEX, codeIn(second));
    expect(paidOut()).toBe(10_000_000n);
    expect(sms.last(ALEX)).toBe(overDaily);
    expect((await getIntent(db, intentIdIn(second)))?.status).toBe("failed");
  });

  it("a request made yesterday and paid today counts toward today", async () => {
    await say(JEREMY, "request $10 from @alex");
    const request = codeIn(sms.last(ALEX));
    clock = new Date(clock.getTime() + 24 * 3600_000);
    await say(ALEX, codeIn(await say(ALEX, "send @bob $10")));
    await say(ALEX, request);
    expect(paidOut()).toBe(10_000_000n);
    expect(sms.last(ALEX)).toBe(overDaily);
  });

  it("a split approved after a send that used up the day pays nobody", async () => {
    const split = await say(ALEX, "split $10 between @jeremy @bob on tempo");
    await say(ALEX, codeIn(await say(ALEX, "send @jeremy $10")));
    await say(ALEX, codeIn(split));
    expect(batches).toEqual([]);
    expect(sms.last(ALEX)).toBe(overDaily);
  });

  it("still lets the day's payments through up to the cap", async () => {
    const first = await say(ALEX, "send @jeremy $10");
    const second = await say(ALEX, "send @bob $5");
    await say(ALEX, codeIn(first));
    await say(ALEX, codeIn(second));
    expect(paidOut()).toBe(CAP);
  });
});

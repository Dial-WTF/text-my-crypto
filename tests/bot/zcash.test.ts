import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import type { InboundSms } from "@/lib/sms/inbound";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000020";
const JEREMY = "+15550000021";

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let zec: FakeAdapter;
let k = 0;

const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `z${++k}` });
const say = async (from: string, body: string) => {
  await handleInbound(deps, msg(from, body));
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  zec = fakeAdapter({ chain: "zcash", defaultBalance: 5_000_000n });
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }), zcash: zec } });
  for (const [phone, name] of [
    [ALEX, "Alex"],
    [JEREMY, "Jeremy"],
  ] as const) {
    await say(phone, "hi");
    await say(phone, name);
  }
});

describe("zcash in texts", () => {
  it("shows testnet ZEC as dollars plus TAZ, never as USDC", async () => {
    await say(ALEX, "send @jeremy $1 on zcash");
    expect(await say(ALEX, "balance")).toBe("You have $100 USDC on Solana, $5 (0.1 TAZ) on Zcash.");
  });

  it("confirms and settles a Zcash send in TAZ with the payment id as the memo", async () => {
    const confirm = await say(ALEX, "send @jeremy $1 on zcash");
    expect(confirm).toMatch(/^Send \$1 \(0\.02 TAZ\) to @jeremy on Zcash\? Reply \d{6} to confirm/);
    expect(confirm).not.toContain("USDC");
    await say(ALEX, codeIn(confirm));
    const texts = sms.to(ALEX);
    expect(texts.some((t) => t.startsWith("Sending $1 (0.02 TAZ) to @jeremy"))).toBe(true);
    expect(texts.some((t) => /^Sent \$1 \(0\.02 TAZ\) to (@jeremy|Jeremy)/.test(t))).toBe(true);
    expect(zec.settled).toHaveLength(1);
    expect(zec.settled[0]?.memo).toMatch(/^pi_/);
  });
});

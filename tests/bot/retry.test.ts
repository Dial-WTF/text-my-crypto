import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import type { InboundSms } from "@/lib/sms/inbound";
import { processInbound } from "@/lib/sms/process";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const NUMBER = "+15550000042";
let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let k = 0;
const msg = (body: string, key = `r${++k}`): InboundSms => ({ to: "+18066071387", from: ALEX, body, dedupeKey: key });

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  let t = Date.parse("2026-10-09T12:00:00Z");
  // Real conversations have time passing: every read of the clock moves it forward a little.
  deps = testDeps(db, {
    sendSms: sms.sendSms,
    adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }) },
    now: () => new Date((t += 250)),
  });
  for (const body of ["hi", "Alex", "send adam $1"]) await processInbound(deps, msg(body));
});

describe("a turn that fails halfway is retried from the top", () => {
  it("still connects the number to the pending payment when the first reply send fails", async () => {
    expect(sms.last(ALEX)).toBe("What's adam's number?");
    const answer = msg("(555) 000-0042", "answer");

    const failing = vi.fn(async () => {
      throw new Error("Payphone send failed 502");
    });
    await expect(processInbound({ ...deps, sendSms: failing }, answer)).rejects.toThrow(/502/);

    expect(await processInbound(deps, answer)).toBe("handled");
    expect(sms.last(ALEX)).toMatch(/^Send \$1 USDC to \+•••••••0042 on Solana\? Reply \d{6} to confirm/);
    expect(sms.to(NUMBER)).toEqual([]);
  });

  it("does not ask the same question twice after a successful answer", async () => {
    await processInbound(deps, msg("(555) 000-0042"));
    expect(await processInbound(deps, msg("(555) 000-0042"))).toBe("handled");
    expect(sms.last(ALEX)).not.toBe("What's adam's number?");
  });
});

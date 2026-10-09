import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { noLlm } from "@/lib/operator/brain";
import type { InboundSms } from "@/lib/sms/inbound";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const JEREMY = "+15550000011";
const T0 = new Date("2026-10-09T12:00:00Z");

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let k = 0;
let clock = T0;

const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `s${++k}` });
const say = async (from: string, body: string) => {
  await handleInbound(deps, msg(from, body));
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";
const later = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  clock = T0;
  deps = { ...testDeps(db, { sendSms: sms.sendSms, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }) } }), now: () => clock };
  for (const [phone, name] of [
    [ALEX, "Alex"],
    [JEREMY, "Jeremy"],
  ] as const) {
    await say(phone, "hi");
    later(1);
    await say(phone, name);
    later(1);
  }
});

describe("a code that never arrived (2026-10-09)", () => {
  it("reminds on small talk without replacing the code, and a status question sends a fresh one", async () => {
    const first = codeIn(await say(ALEX, "send @jeremy $1.69"));
    later(1);
    // The code text is lost upstream; they text something else.
    expect(await say(ALEX, "yo")).toBe(
      'Still waiting on you: $1.69 to Jeremy. Reply with the code from my text, or text "status" for a new one.',
    );
    later(1);
    const fresh = await say(ALEX, "did it work?");
    expect(fresh).toMatch(/^Still waiting on you: \$1\.69 to Jeremy\. I didn't get your code\. New code: reply \d{6} to confirm/);
    const code = codeIn(fresh);
    if (code !== first) expect(await say(ALEX, first)).toMatch(/^That code didn't match/);
    later(1);
    await say(ALEX, code);
    expect(sms.to(ALEX).slice(-2)).toEqual([
      "Sending $1.69 to @jeremy on Solana…",
      expect.stringMatching(/^Sent \$1\.69 to Jeremy on Solana\. Receipt: /),
    ]);
    later(1);
    expect(await say(ALEX, "did it go through?")).toMatch(/^Yes, it went through: \$1\.69 to Jeremy\. Receipt: /);
  });

  it("the original code still works after a reminder", async () => {
    const code = codeIn(await say(ALEX, "send @jeremy $2"));
    later(1);
    await say(ALEX, "hello?");
    later(1);
    await say(ALEX, code);
    expect(sms.to(ALEX).at(-1)).toMatch(/^Sent \$2 to Jeremy/);
  });

  it("says plainly when it expired, and a late code gets the same answer", async () => {
    const code = codeIn(await say(ALEX, "send @jeremy $3"));
    later(11);
    expect(await say(ALEX, "yo")).toBe("Your $3 to Jeremy expired before I got a code, so nothing moved. Text it again to retry.");
    later(1);
    expect(await say(ALEX, code)).toBe("That code expired, so nothing was sent. Text the payment again for a fresh one.");
  });
});

describe("status questions", () => {
  it("has nothing to report when nothing is in flight", async () => {
    expect(await say(ALEX, "status")).toBe('Nothing in flight right now. Text "balance", "wallet" or "send @name $5".');
  });

  it("tells a requester they're waiting, and gives the payer a fresh code", async () => {
    await say(ALEX, "request $5 from @jeremy");
    later(1);
    expect(await say(ALEX, "any update?")).toBe("Still waiting for Jeremy to pay your $5 request. I'll text you when they do.");
    later(1);
    const ask = await say(JEREMY, "what happened?");
    expect(ask).toMatch(/^Alex is still waiting for your \$5\. New code: reply \d{6} to pay, or NO to decline\.$/);
    later(1);
    await say(JEREMY, codeIn(ask));
    expect(sms.to(JEREMY).at(-1)).toMatch(/^Sent \$5 to Alex/);
  });

  it("does not drop a question the operator asked", async () => {
    expect(await say(ALEX, "send bob $1")).toBe("What's bob's number?");
    later(1);
    await say(ALEX, "status");
    later(1);
    expect(await say(ALEX, "(555) 000-0055")).toMatch(/^Send \$1 USDC to /);
  });
});

describe("small talk", () => {
  it("never sends the same canned line twice in a row (no language model, as in production today)", async () => {
    deps = { ...deps, llm: noLlm };
    const one = await say(ALEX, "purple monkey dishwasher");
    later(1);
    const two = await say(ALEX, "banana phone");
    expect(one).toBe('I\'m the Dial operator. I move money by text. Try "send jeremy $10".');
    expect(two).toBe('Not sure what you mean. Try "balance", "send @name $5", "request $5 from @name" or "wallet".');
  });

  it("takes thanks", async () => {
    expect(await say(ALEX, "thanks!")).toBe("Anytime.");
  });
});

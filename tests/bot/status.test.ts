import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import { statusReply } from "@/lib/bot/status";
import type { BotDeps } from "@/lib/bot/types";
import { MAX_CODE_ATTEMPTS } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import { findUserByPhone } from "@/lib/identity";
import { getIntent } from "@/lib/intents";
import { noLlm } from "@/lib/operator/brain";
import type { InboundSms } from "@/lib/sms/inbound";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, fakeEscrow, smsSink, testDeps } from "../helpers/fakes";

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
const intentIdIn = (s: string) => /\/a\/(pi_[\w-]+)/.exec(s)?.[1] ?? "";
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
    await say(phone, `call me ${name}`);
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
    expect(await say(ALEX, "status")).toBe("Nothing in flight right now. Text BALANCE to see your money.");
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

describe("asking for a new code never buys more guesses", () => {
  const wrongCodes = (real: string) => ["000001", "000002", "000003", "000004", "000005", "000006"].filter((c) => c !== real);

  it("a fresh code keeps the wrong tries already made", async () => {
    const confirm = await say(ALEX, "send @jeremy $1");
    const wrong = wrongCodes(codeIn(confirm));
    await say(ALEX, wrong[0]!);
    later(0.2);
    expect(await say(ALEX, wrong[1]!)).toBe("That code didn't match. 3 tries left.");
    later(0.2);
    const fresh = codeIn(await say(ALEX, "status"));
    expect(fresh).toMatch(/^\d{6}$/);
    later(0.2);
    expect(await say(ALEX, wrongCodes(fresh)[2]!)).toBe("That code didn't match. 2 tries left.");
  });

  it("a payment locked by wrong codes gets no new code from status or a repeat", async () => {
    const confirm = await say(ALEX, "send @jeremy $1");
    const id = intentIdIn(confirm);
    const wrong = wrongCodes(codeIn(confirm));
    for (const c of wrong.slice(0, 5)) {
      await say(ALEX, c);
      later(0.2);
    }
    expect(sms.last(ALEX)).toBe("That code didn't match and that was the last try. Text the payment again for a new code.");
    const locked = await getIntent(db, id);

    expect(await say(ALEX, "status")).toBe("That code didn't match and that was the last try. Text the payment again for a new code.");
    later(0.2);
    expect(await say(ALEX, "send @jeremy $1")).toBe(
      "That code didn't match and that was the last try. Text the payment again for a new code.",
    );
    const after = await getIntent(db, id);
    expect(after?.codeHash).toBe(locked?.codeHash);
    expect(after?.codeAttempts).toBe(MAX_CODE_ATTEMPTS);
  });
});

describe("which payment status talks about", () => {
  it("prefers the payment waiting on their code over money that just landed", async () => {
    await say(ALEX, "send @jeremy $2");
    later(1);
    const back = await say(JEREMY, "send @alex $1");
    later(1);
    await say(JEREMY, codeIn(back));
    expect(sms.to(ALEX).at(-1)).toMatch(/you got \$1 from Jeremy/);
    later(1);
    expect(await say(ALEX, "yo")).toBe(
      'Still waiting on you: $2 to Jeremy. Reply with the code from my text, or text "status" for a new one.',
    );
    later(1);
    expect(await say(ALEX, "did it work?")).toMatch(/^Still waiting on you: \$2 to Jeremy\. I didn't get your code\. New code: reply \d{6}/);
  });

  it("falls back to the newest payment when nothing is waiting", async () => {
    const back = await say(JEREMY, "send @alex $1");
    later(1);
    await say(JEREMY, codeIn(back));
    later(1);
    expect(await say(ALEX, "did it work?")).toMatch(/^Yes: you got \$1 from Jeremy\./);
  });
});

describe("status on an escrow", () => {
  const SAM = "+15550000055";

  async function escrowToSam(amount: string): Promise<string> {
    const confirm = await say(ALEX, `send $${amount} to (555) 000-0055`);
    later(1);
    await say(ALEX, codeIn(confirm));
    later(1);
    return intentIdIn(confirm);
  }

  it("after a claim that didn't land, tells the recipient it's waiting for them, with a claim code that works", async () => {
    const esc = fakeEscrow();
    deps = { ...deps, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n, escrow: esc }) } };
    const id = await escrowToSam("5");
    esc.fail.next = new Error("Transaction simulation failed");
    await say(SAM, "yes");
    later(1);
    const offered = codeIn(sms.last(SAM));
    expect(offered).toMatch(/^\d{6}$/);

    const reply = await say(SAM, "did it work?");
    expect(reply).toMatch(/^Alex sent you \$5 and it's waiting for you to claim it\. New code: reply \d{6} to claim it\.$/);
    const fresh = codeIn(reply);
    later(1);
    if (fresh !== offered) expect(await say(SAM, offered)).toMatch(/^That code didn't match/);
    later(1);
    await say(SAM, fresh);
    const [claimed, tour] = sms.to(SAM).slice(-2);
    expect(claimed).toMatch(/^You got money! \$5 from Alex/);
    expect(tour).toMatch(/^Your Dial wallet: /);
    expect((await getIntent(db, id))?.status).toBe("settled");
  });

  it("tells the recipient of a refunded escrow it went back to the sender, not to them", async () => {
    const id = await escrowToSam("4");
    later(8 * 24 * 60);
    expect(await say(ALEX, "reclaim")).toBe("Got back $4 from 1 unclaimed payment.");
    const refunded = await getIntent(db, id);
    expect(refunded?.status).toBe("refunded");

    await say(SAM, "hi");
    later(1);
    await say(SAM, "call me Sam");
    const sam = await findUserByPhone(db, SAM);
    const alex = await findUserByPhone(db, ALEX);
    expect(await statusReply(deps, sam!, refunded)).toBe(
      "The $4 from Alex wasn't claimed in time, so it went back to them. Ask them to send it again.",
    );
    expect(await statusReply(deps, alex!, refunded)).toMatch(/^That \$4 came back to you\./);
  });
});

describe("small talk", () => {
  it("never sends the same canned line twice in a row (no language model, as in production today)", async () => {
    deps = { ...deps, llm: noLlm };
    const one = await say(ALEX, "purple monkey dishwasher");
    later(1);
    const two = await say(ALEX, "banana phone");
    expect(one).toBe("This is Dial Up Banking: I move money by text. To pay someone, text SEND @name $5. Text HELP anytime.");
    expect(two).toBe("I didn't get that. Text HELP to see everything I can do.");
  });

  it("takes thanks", async () => {
    expect(await say(ALEX, "thanks!")).toBe("Anytime.");
  });
});

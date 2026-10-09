import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { findUserByPhone } from "@/lib/identity";
import { getIntent } from "@/lib/intents";
import { noLlm } from "@/lib/operator/brain";
import { ChainDownError } from "@/lib/settlement/types";
import type { InboundSms } from "@/lib/sms/inbound";
import { getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const JEREMY = "+15550000011";
const NEWBIE = "+15550000099";

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let sol: FakeAdapter;
let k = 0;

const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `e${++k}` });
const send = (from: string, body: string) => handleInbound(deps, msg(from, body));
const say = async (from: string, body: string) => {
  await send(from, body);
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";
const intentIdIn = (s: string) => /\/a\/(pi_[\w-]+)/.exec(s)?.[1] ?? "";
const signUp = async (phone: string, name: string) => {
  await say(phone, "hi");
  return say(phone, name);
};

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  sol = fakeAdapter({ defaultBalance: 100_000_000n });
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: sol } });
  await signUp(ALEX, "Alex");
  await signUp(JEREMY, "Jeremy");
});

describe("STOP / START / HELP", () => {
  it("opts out with one confirmation, stays silent, and comes back on START", async () => {
    expect(await say(ALEX, "STOP")).toBe(
      "You're unsubscribed from the Dial operator. No more texts. Your money stays in your wallet: reply START anytime to get back to it.",
    );
    const before = sms.to(ALEX).length;
    expect(await send(ALEX, "send @jeremy $5")).toEqual([]);
    expect(await send(ALEX, "help")).toEqual([]);
    expect(await send(ALEX, "stop")).toEqual([]);
    expect(sms.to(ALEX)).toHaveLength(before);
    expect(await say(ALEX, "start")).toMatch(/^Welcome back\./);
    expect(await say(ALEX, "balance")).toBe("You have $100 USDC on Solana.");
  });

  it("works for strangers too, and HELP always explains how to stop", async () => {
    expect(await say(NEWBIE, "stop")).toMatch(/^You're unsubscribed/);
    expect(await send(NEWBIE, "hi")).toEqual([]);
    expect(await send(ALEX, "HELP")).toEqual([
      "Dial operator by Dial.Work: send and get paid in crypto by text. Help: https://tmc.test/how-it-works. Msg & data rates may apply. Reply STOP to cancel.",
      "Commands: send @name $5, request $5 from @name, invoice @name $5, balance, receive, wallet, withdraw all to <address>, reclaim, 411 name, connect agent, status.",
    ]);
  });

  it("CANCEL with a payment waiting on its code cancels it and says so in the opt-out", async () => {
    const confirm = await say(ALEX, "send @jeremy $5");
    const id = intentIdIn(confirm);
    expect(await say(ALEX, "CANCEL")).toBe(
      "You're unsubscribed from the Dial operator. No more texts. Your pending payment won't go through. Your money stays in your wallet: reply START anytime to get back to it.",
    );
    expect((await getIntent(db, id))?.status).toBe("declined");
    await say(ALEX, "start");
    expect(await say(ALEX, codeIn(confirm))).not.toMatch(/^Sending/);
    expect(sol.settled).toHaveLength(0);
  });

  it("CANCEL with nothing pending is a plain opt-out, and STOP leaves a pending payment alone", async () => {
    expect(await say(JEREMY, "cancel")).toMatch(/^You're unsubscribed from the Dial operator\. No more texts\. Your money stays/);
    const id = intentIdIn(await say(ALEX, "send @jeremy $5"));
    expect(await say(ALEX, "stop")).not.toMatch(/pending payment/);
    expect((await getIntent(db, id))?.status).toBe("pending");
  });

  it("never texts an opted-out recipient, and tells the sender the money is waiting", async () => {
    await say(NEWBIE, "stop");
    await say(ALEX, codeIn(await say(ALEX, "send $5 to (555) 000-0099")));
    expect(sms.to(NEWBIE)).toHaveLength(1);
    expect(sms.last(ALEX)).toBe("+•••••••0099 has turned off texts from me, so I couldn't tell them. The money waits for them for 7 days.");
  });
});

describe("double-taps and repeats", () => {
  it("answers once when the same text arrives twice in a row", async () => {
    const [first, second] = await Promise.all([send(ALEX, "balance"), send(ALEX, "balance")]);
    expect([...first, ...second]).toEqual(["You have $100 USDC on Solana."]);
  });

  it("answers a deliberate repeat after the operator replied, without making a second payment", async () => {
    const first = await say(ALEX, "send @jeremy $5");
    const again = await say(ALEX, "send @jeremy $5");
    expect(again).toMatch(/^You already asked to send \$5 to @jeremy\. Reply \d{6} to confirm that one, or NEW to make it a second payment\.$/);
    await say(ALEX, codeIn(again));
    expect(sms.last(ALEX)).toMatch(/^Sent \$5 to Jeremy/);
    expect((await getIntent(db, intentIdIn(first)))?.status).toBe("settled");
  });

  it("makes a second payment when asked to with NEW", async () => {
    await say(ALEX, "send @jeremy $5");
    await say(ALEX, "send @jeremy $5");
    const confirm = await say(ALEX, "new");
    expect(confirm).toMatch(/^Send \$5 USDC to @jeremy on Solana\? Reply \d{6}/);
  });

  it("doesn't nag about a repeated request", async () => {
    await say(JEREMY, "request $25 from @alex");
    expect(await say(JEREMY, "request $25 from @alex")).toBe("You already asked @alex for $25. I'll text you when they pay.");
  });
});

describe("codes", () => {
  it("accepts codes typed with spaces or dashes", async () => {
    const code = codeIn(await say(ALEX, "send @jeremy $2"));
    await say(ALEX, `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(sms.last(ALEX)).toMatch(/^Sent \$2 to Jeremy/);
  });

  it("explains codes when someone replies yes", async () => {
    await say(ALEX, "send @jeremy $2");
    expect(await say(ALEX, "yes")).toBe(
      "To confirm, reply with the 6-digit code from my last text. It keeps anyone else from spending your money.",
    );
  });

  it("says 'sending' right away, then sends the receipt", async () => {
    await say(ALEX, codeIn(await say(ALEX, "send @jeremy $2")));
    const [ack, receipt] = sms.to(ALEX).slice(-2);
    expect(ack).toBe("Sending $2 to @jeremy on Solana…");
    expect(receipt).toMatch(/^Sent \$2 to Jeremy on Solana\. Receipt: /);
  });

  it("re-checks the balance at approval time", async () => {
    const code = codeIn(await say(ALEX, "send @jeremy $20"));
    const alex = await findUserByPhone(db, ALEX);
    sol.balances.set((await getWallet(db, alex!.id, "solana"))!.address, 3_000_000n);
    expect(await say(ALEX, code)).toBe("You only have $3 now, so I didn't send it. Nothing moved.");
    expect(sol.settled).toHaveLength(0);
  });
});

describe("cancelling and bad targets", () => {
  it("nevermind cancels a payment that was never approved", async () => {
    const confirm = await say(ALEX, "send @jeremy $4");
    expect(await say(ALEX, "nevermind")).toBe("OK, cancelled. Nothing was sent.");
    expect((await getIntent(db, intentIdIn(confirm)))?.status).toBe("declined");
    expect(await say(ALEX, codeIn(confirm))).toBe("Your $4 with Jeremy was cancelled. Nothing moved.");
  });

  it("nevermind drops a pending question", async () => {
    expect(await say(ALEX, "send mom $4")).toBe("What's mom's number?");
    expect(await say(ALEX, "nvm")).toBe("OK, forgot about it.");
    expect(await say(ALEX, "(555) 000-0123")).not.toMatch(/^Send /);
  });

  it("refuses the operator's own number and zero amounts", async () => {
    expect(await say(ALEX, "send $5 to (806) 607-1387")).toBe("That's my number. Who should get the money?");
    expect(await say(ALEX, "send @jeremy $0")).toBe("Amounts can be from $0.01 to $50.");
  });
});

describe("chain outages", () => {
  it("says the network is down right away instead of going silent, and keeps the question", async () => {
    const down = fakeAdapter({ defaultBalance: 100_000_000n });
    down.getBalance = async () => {
      throw new ChainDownError("solana", new Error("HTTP 403"));
    };
    deps = { ...deps, adapters: { solana: down } };
    expect(await say(ALEX, "send mom $1")).toBe("What's mom's number?");
    expect(await say(ALEX, "(555) 000-0055")).toBe("The Solana network isn't answering right now. Nothing moved. Try again in a minute.");
    deps = { ...deps, adapters: { solana: sol } };
    expect(await say(ALEX, "(555) 000-0055")).toMatch(/^Send \$1 USDC to \+•••••••0055/);
  });
});

describe("test-funds drip", () => {
  it("retries a drip that failed at signup the first time they come up short, and only once", async () => {
    const broke = fakeAdapter({ defaultBalance: 0n });
    const fund = broke.fund;
    broke.fund = async () => {
      throw new ChainDownError("solana", new Error("HTTP 403"));
    };
    deps = { ...deps, adapters: { solana: broke } };
    expect(await signUp(NEWBIE, "Sam")).not.toMatch(/test USDC/);

    broke.fund = fund;
    expect(await say(NEWBIE, "send @alex $1")).toMatch(/^Send \$1 USDC to @alex/);
    expect(sms.to(NEWBIE)).toContain(
      "Dial is on testnet for now, so I put $25 of test USDC in your wallet to try it. It's play money, not real dollars.",
    );
    expect(broke.funded).toHaveLength(1);

    expect(await say(NEWBIE, "send @jeremy $30")).toBe(
      "You have $0 in test USDC, not enough for that one. Add more: https://tmc.test/@sam Free test USDC: faucet.circle.com",
    );
    expect(broke.funded).toHaveLength(1);
  });
});

describe("things the operator can't parse", () => {
  it("asks for the number of a multi-word name", async () => {
    expect(await say(ALEX, "send my guy $1")).toBe("What's my guy's number?");
  });

  it("explains the format when a payment can't be understood and no model is configured", async () => {
    deps = { ...deps, llm: noLlm };
    expect(await say(ALEX, "send some money to that guy from yesterday")).toBe(
      'I didn\'t catch who or how much. Try "send @jeremy $5", "send $5 to +1 555 123 4567" or "request $10 from alex".',
    );
  });
});

describe("requests to people who aren't on Dial yet", () => {
  it("shows the request again with a fresh code after they sign up", async () => {
    await say(JEREMY, "request $8 from (555) 000-0099 for lunch");
    // No code yet: they can't use one until they sign up.
    expect(sms.last(NEWBIE)).toBe(
      "Jeremy is asking you for $8 USDC (lunch) on Dial. Reply HI to see it. Dial operator: msg & data rates may apply. Reply STOP to opt out.",
    );
    await say(NEWBIE, "hey");
    await send(NEWBIE, "Riley");
    const thread = sms.to(NEWBIE);
    expect(thread.at(-2)).toMatch(/^You're in, Riley\./);
    const offer = thread.at(-1) ?? "";
    expect(offer).toMatch(/^Jeremy is asking you for \$8 USDC \(lunch\)\./);
    expect(offer).toMatch(/Reply \d{6} to pay or NO to decline/);
    await say(NEWBIE, codeIn(offer));
    expect(sms.last(JEREMY)).toMatch(/^Riley paid you \$8 \(lunch\)\./);
  });

  it("an invoice to someone not on Dial carries no code and the opt-out line", async () => {
    await say(JEREMY, "invoice (555) 000-0098 $20 for design");
    expect(sms.last("+15550000098")).toBe(
      "Jeremy sent you an invoice for $20 USDC (design) on Dial. Reply HI to see it. Dial operator: msg & data rates may apply. Reply STOP to opt out.",
    );
  });
});

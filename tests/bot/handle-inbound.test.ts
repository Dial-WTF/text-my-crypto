import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { findUserByPhone } from "@/lib/identity";
import { getIntent } from "@/lib/intents";
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
let clock: Date;
let k = 0;

const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `k${++k}` });
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

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  sol = fakeAdapter({ defaultBalance: 100_000_000n });
  clock = new Date("2026-10-09T12:00:00Z");
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: sol }, now: () => clock });
});

describe("signup over SMS", () => {
  it("asks for a name, then creates the account, wallet and test drip", async () => {
    expect(await say(JEREMY, "hi")).toBe(
      "hi, I'm the Dial operator. I can help you text your crypto. What name should people use to pay you?",
    );
    expect(await say(JEREMY, "Jeremy")).toBe(
      "You're in, jeremy. I dropped $25 of test USDC in your wallet. Try: send jeremy $5",
    );
    const u = await findUserByPhone(db, JEREMY);
    expect(u?.handle).toBe("jeremy");
    expect(await getWallet(db, u!.id, "solana")).not.toBeNull();
    expect(sol.funded).toHaveLength(1);
  });

  it("rejects bad and taken names", async () => {
    await signUp(ALEX, "alex");
    await say(JEREMY, "hi");
    expect(await say(JEREMY, "x")).toMatch(/^Names are 3-20/);
    expect(await say(JEREMY, "alex")).toBe("alex is taken. Try another?");
    expect(await say(JEREMY, "jeremy")).toMatch(/^You're in, jeremy/);
  });

  it("ignores a duplicate delivery", async () => {
    const m = msg(JEREMY, "hi");
    await handleInbound(deps, m);
    expect(await handleInbound(deps, m)).toEqual([]);
  });
});

describe("send to someone on Dial", () => {
  beforeEach(async () => {
    await signUp(ALEX, "alex");
    await signUp(JEREMY, "jeremy");
  });

  it("asks for an unknown name's number, remembers it, and pays on the texted code", async () => {
    expect(await say(ALEX, "send jeremy $10 for pizza")).toBe("What's jeremy's number?");
    const confirm = await say(ALEX, "(555) 000-0011");
    expect(confirm).toMatch(/^Send \$10 USDC to jeremy \(pizza\) on Solana\? Reply \d{6} to confirm, or tap: https:\/\/tmc\.test\/a\/pi_/);

    await say(ALEX, codeIn(confirm));
    expect(sms.last(ALEX)).toMatch(/^Sent \$10 to jeremy on Solana\. Receipt: https:\/\/explorer\.test\//);
    expect(sms.last(JEREMY)).toBe("jeremy, you got $10 from alex (pizza) on Solana. Text \"balance\" anytime.");
    const jeremy = await findUserByPhone(db, JEREMY);
    const jw = await getWallet(db, jeremy!.id, "solana");
    expect(sol.settled.at(-1)).toMatchObject({ to: jw!.address, amount: 10_000_000n, closeSource: false });

    expect(await say(ALEX, "send jeremy $1")).toMatch(/^Send \$1 USDC to jeremy on Solana\? Reply \d{6}/);
  });

  it("pays a global @handle directly", async () => {
    expect(await say(ALEX, "send @jeremy $2")).toMatch(/^Send \$2 USDC to jeremy/);
    expect(await say(ALEX, "send @nobody $2")).toBe("There's no Dial user called @nobody. Send their phone number instead.");
  });

  it("rejects wrong codes and locks after five", async () => {
    const confirm = await say(ALEX, "send @jeremy $3");
    const right = codeIn(confirm);
    const wrong = right === "000000" ? "111111" : "000000";
    expect(await say(ALEX, wrong)).toBe("That code didn't match anything waiting on you. Check my last text.");
    for (let i = 0; i < 4; i++) await say(ALEX, wrong);
    expect(await say(ALEX, right)).toBe("That code didn't match anything waiting on you. Check my last text.");
    expect(sol.settled).toHaveLength(0);
  });

  it("can't be approved twice or after it expires", async () => {
    const confirm = await say(ALEX, "send @jeremy $3");
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect(await say(ALEX, codeIn(confirm))).toBe("That code didn't match anything waiting on you. Check my last text.");
  });

  it("enforces per-payment, daily and balance limits", async () => {
    expect(await say(ALEX, "send @jeremy $51")).toBe("Test mode caps payments at $50. Try a smaller amount.");
    deps = { ...deps, perDayCap: 15_000_000n };
    await say(ALEX, codeIn(await say(ALEX, "send @jeremy $10")));
    expect(await say(ALEX, "send @jeremy $10")).toMatch(/^Text-only accounts can send \$15 a day/);
    sol.balances.set((await getWallet(db, (await findUserByPhone(db, JEREMY))!.id, "solana"))!.address, 2_000_000n);
    expect(await say(JEREMY, "send @alex $5")).toBe("You have $2. Not enough for that one.");
  });

  it("says when a chain isn't on yet", async () => {
    expect(await say(ALEX, "send @jeremy $1 on tempo")).toBe("Tempo isn't switched on yet. Try Solana.");
  });
});

describe("send to someone not on Dial (escrow)", () => {
  beforeEach(async () => {
    await signUp(ALEX, "alex");
  });

  async function sendToNewbie(amount = "5") {
    const confirm = await say(ALEX, `send $${amount} to (555) 000-0099`);
    expect(confirm).toMatch(new RegExp(`^Send \\$${amount} USDC to \\+•••••••0099 on Solana\\? Reply \\d{6}`));
    await say(ALEX, codeIn(confirm));
    return intentIdIn(confirm);
  }

  it("funds an escrow, and only the phone's owner can claim it with the texted code", async () => {
    const id = await sendToNewbie();
    const intent = await getIntent(db, id);
    expect(intent?.status).toBe("escrowed");
    expect(sol.settled.at(-1)).toMatchObject({ to: intent?.recipientAddress, amount: 5_000_000n });
    expect(sms.last(ALEX)).toBe('Sent $5 to +•••••••0099. They have 7 days to claim it. If they don\'t, text "reclaim" to get it back.');
    expect(sms.last(NEWBIE)).toBe("alex sent you $5 USDC on Dial. Reply to this text to claim it.");

    expect(await say(NEWBIE, "hey")).toBe(
      "hi, I'm the Dial operator. alex sent you $5 USDC and it's waiting for you. What name should people use to pay you?",
    );
    await say(NEWBIE, "riley");
    const offer = sms.to(NEWBIE).find((m) => m.startsWith("alex sent you $5 USDC. Reply")) ?? "";
    expect(offer).toMatch(/Reply \d{6} to claim it\.$/);

    await say(NEWBIE, codeIn(offer));
    const riley = await findUserByPhone(db, NEWBIE);
    const rw = await getWallet(db, riley!.id, "solana");
    expect(sol.settled.at(-1)).toMatchObject({ to: rw!.address, amount: 5_000_000n, memo: id, closeSource: true });
    expect(sms.last(NEWBIE)).toMatch(/^Claimed \$5 from alex\. Receipt: /);
    expect(sms.last(ALEX)).toBe("riley claimed the $5 you sent.");
    expect((await getIntent(db, id))?.status).toBe("settled");
  });

  it("lets the sender reclaim only after the escrow expires", async () => {
    const id = await sendToNewbie("4");
    expect(await say(ALEX, "reclaim")).toBe("Nothing to reclaim right now. Unclaimed payments can come back after 7 days.");
    clock = new Date(clock.getTime() + 8 * 86_400_000);
    expect(await say(ALEX, "reclaim")).toBe("Got back $4 from 1 unclaimed payment.");
    const alexWallet = await getWallet(db, (await findUserByPhone(db, ALEX))!.id, "solana");
    expect(sol.settled.at(-1)).toMatchObject({ to: alexWallet!.address, closeSource: true });
    expect((await getIntent(db, id))?.status).toBe("refunded");
  });
});

describe("request and invoice", () => {
  beforeEach(async () => {
    await signUp(ALEX, "alex");
    await signUp(JEREMY, "jeremy");
  });

  it("texts the payer a code, and paying it notifies the requester", async () => {
    expect(await say(JEREMY, "request $25 from @alex for pizza")).toBe("Asked alex for $25. I'll text you when they pay.");
    const ask = sms.last(ALEX);
    expect(ask).toMatch(/^jeremy is asking you for \$25 USDC \(pizza\)\. Reply \d{6} to pay or NO to decline\. Or tap: /);
    await say(ALEX, codeIn(ask));
    expect(sms.last(JEREMY)).toMatch(/^alex paid you \$25 \(pizza\)\. Receipt: /);
    expect(sms.last(ALEX)).toMatch(/^Sent \$25 to jeremy on Solana/);
  });

  it("lets the payer decline", async () => {
    await say(JEREMY, "invoice @alex $40 for logo design");
    expect(sms.last(ALEX)).toMatch(/^jeremy sent you an invoice for \$40 USDC \(logo design\)\. Reply \d{6} to pay or NO/);
    expect(await say(ALEX, "no")).toBe("Declined. Nothing was paid.");
    expect(sms.last(JEREMY)).toBe("alex declined your request for $40.");
    expect(await say(ALEX, "no")).toBe("Nothing waiting on you to decline.");
  });
});

describe("withdraw", () => {
  const OUT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  beforeEach(async () => {
    await signUp(ALEX, "alex");
  });

  it("withdraws to an outside address after the texted code", async () => {
    const confirm = await say(ALEX, `withdraw $12 to ${OUT}`);
    expect(confirm).toMatch(/^Withdraw \$12 USDC to 7xKX…gAsU on Solana\? Reply \d{6} to confirm/);
    await say(ALEX, codeIn(confirm));
    expect(sol.settled.at(-1)).toMatchObject({ to: OUT, amount: 12_000_000n });
    expect(sms.last(ALEX)).toMatch(/^Withdrew \$12 to 7xKX…gAsU\. Receipt: /);
  });

  it("withdraws everything and rejects bad addresses", async () => {
    expect(await say(ALEX, `withdraw all to ${OUT}`)).toMatch(/^Withdraw \$50 USDC|^Test mode caps/);
    expect(await say(ALEX, "withdraw $1 to 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb on tempo")).toBe(
      "Tempo isn't switched on yet. Try Solana.",
    );
  });
});

describe("balance, receive, upgrade, chat", () => {
  beforeEach(async () => {
    await signUp(ALEX, "alex");
  });

  it("answers balance and receive", async () => {
    expect(await say(ALEX, "balance")).toBe("You have $100 USDC on Solana.");
    expect(await say(ALEX, "receive")).toBe('People can text me "send alex $5". Or send USDC to Solana: solanaAddr1');
  });

  it("offers a passkey upgrade link", async () => {
    expect(await say(ALEX, "upgrade")).toMatch(/^Add a passkey for one-tap approvals and higher limits: https:\/\/tmc\.test\/s\//);
  });

  it("chats", async () => {
    expect(await say(ALEX, "yo what is this")).toMatch(/Dial operator/);
  });
});

describe("chains", () => {
  it("opens a wallet on every enabled chain at signup", async () => {
    const tempo = fakeAdapter({ chain: "tempo" });
    deps = { ...deps, adapters: { solana: sol, tempo } };
    await signUp(ALEX, "alex");
    const u = await findUserByPhone(db, ALEX);
    expect(await getWallet(db, u!.id, "tempo")).not.toBeNull();
  });
});

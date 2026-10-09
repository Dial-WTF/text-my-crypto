import { beforeEach, describe, expect, it } from "vitest";
import { ensureWallet } from "@/lib/bot/accounts";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { findUserByPhone } from "@/lib/identity";
import { claimForSettlement, getIntent } from "@/lib/intents";
import { reconcileEscrows } from "@/lib/bot/settle";
import { EscrowExpiredError, type EscrowLookup, EscrowUnconfirmedError } from "@/lib/settlement/types";
import type { InboundSms } from "@/lib/sms/inbound";
import { getWallet } from "@/lib/wallets";
import { passkeys } from "@/lib/db/schema";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, fakeEscrow, smsSink, testDeps } from "../helpers/fakes";

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
      "hi, I'm the Dial operator by Dial.Work. I can help you text your crypto. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Terms: https://tmc.test/terms\nWhat name should people use to pay you?",
    );
    expect(await say(JEREMY, "Jeremy")).toBe(
      'You\'re in, Jeremy. Your Dial name is @jeremy, so people can text me "send @jeremy $5". Dial is on testnet for now, so I put $25 of test USDC in your wallet to try it. It\'s play money, not real dollars. Text 411 and a name to find anyone. Text HELP anytime.',
    );
    const u = await findUserByPhone(db, JEREMY);
    expect(u?.handle).toBe("jeremy");
    expect(u?.name).toBe("Jeremy");
    expect(await getWallet(db, u!.id, "solana")).not.toBeNull();
    expect(sol.funded).toHaveLength(1);
  });

  it("accepts whatever people call themselves and derives a free handle", async () => {
    await say(JEREMY, "yo");
    expect(await say(JEREMY, "J. P. Meyer, Crypto Anartist Imperialist and Bank Robber lmao")).toMatch(
      /^You're in, J\. P\. Meyer\. Your Dial name is @jpmeyer,/,
    );
    await signUp(ALEX, "J.P. Meyer");
    expect((await findUserByPhone(db, ALEX))?.handle).toBe("jpmeyer2");
  });

  it("asks again for nonsense names and for commands sent before a name", async () => {
    await say(JEREMY, "hi");
    expect(await say(JEREMY, "!!!")).toBe("What should I call you? Any name works, like Alex or J. P. Meyer.");
    expect(await say(JEREMY, "send alex $5")).toBe("First things first: what name should people use to pay you?");
    // Too short for a handle: the fallback is random, never the phone's last digits (handles are public).
    expect(await say(JEREMY, "Al")).toMatch(/^You're in, Al\. Your Dial name is @dial[a-z2-7]{4},/);
    expect((await findUserByPhone(db, JEREMY))?.handle).not.toContain("0011");
  });

  it("signs up someone called Ty instead of welcoming them again", async () => {
    await say(NEWBIE, "hi");
    expect(await say(NEWBIE, "Ty")).toMatch(/^You're in, Ty\. Your Dial name is @dial[a-z2-7]{4},/);
    expect((await findUserByPhone(db, NEWBIE))?.name).toBe("Ty");
    // Once they're in, the same word is thanks again.
    clock = new Date(clock.getTime() + 2 * 60_000);
    expect(await say(NEWBIE, "ty")).toBe("Anytime.");
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
    expect(await say(ALEX, "send mom $10 for pizza")).toBe("What's mom's number?");
    const confirm = await say(ALEX, "(555) 000-0011");
    expect(confirm).toMatch(/^Send \$10 USDC to @jeremy \(pizza\) on Solana\? Reply \d{6} to confirm, or tap: https:\/\/tmc\.test\/a\/pi_/);

    await say(ALEX, codeIn(confirm));
    expect(sms.last(ALEX)).toMatch(/^Sent \$10 to jeremy on Solana\. Receipt: https:\/\/explorer\.test\//);
    expect(sms.last(JEREMY)).toMatch(/^jeremy, you got \$10 from alex \(pizza\) on Solana\. Receipt: https:\/\/explorer\.test\/sig_pi_/);
    const jeremy = await findUserByPhone(db, JEREMY);
    const jw = await getWallet(db, jeremy!.id, "solana");
    expect(sol.settled.at(-1)).toMatchObject({ to: jw!.address, amount: 10_000_000n, closeSource: false });

    expect(await say(ALEX, "send mom $1")).toMatch(/^Send \$1 USDC to @jeremy on Solana\? Reply \d{6}/);
  });

  it("pays a global @handle directly", async () => {
    expect(await say(ALEX, "send @jeremy $2")).toMatch(/^Send \$2 USDC to @jeremy/);
    expect(await say(ALEX, "send @nobody $2")).toBe("There's no Dial user called @nobody. Send their phone number instead.");
  });

  it("rejects wrong codes and locks after five", async () => {
    const confirm = await say(ALEX, "send @jeremy $3");
    const right = codeIn(confirm);
    const wrong = right === "000000" ? "111111" : "000000";
    expect(await say(ALEX, wrong)).toBe("That code didn't match. 4 tries left.");
    expect(await say(ALEX, wrong)).toBe("That code didn't match. 3 tries left.");
    for (let i = 0; i < 3; i++) await say(ALEX, wrong);
    expect(await say(ALEX, right)).toBe(
      "That code didn't match and that was the last try. Text the payment again for a new code.",
    );
    expect(sol.settled).toHaveLength(0);
  });

  it("can't be approved twice or after it expires", async () => {
    const confirm = await say(ALEX, "send @jeremy $3");
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect(await say(ALEX, codeIn(confirm))).toBe(
      "That code expired, so nothing was sent. Text the payment again for a fresh one.",
    );
  });

  it("enforces per-payment, daily and balance limits", async () => {
    expect(await say(ALEX, "send @jeremy $51")).toBe("Test mode caps payments at $50. Try a smaller amount.");
    deps = { ...deps, perDayCap: 15_000_000n };
    await say(ALEX, codeIn(await say(ALEX, "send @jeremy $10")));
    expect(await say(ALEX, "send @jeremy $10")).toBe("You just sent @jeremy $10. Reply NEW if you meant to send another.");
    expect(await say(ALEX, "new")).toMatch(/^Text-only accounts can send \$15 a day/);
    sol.balances.set((await getWallet(db, (await findUserByPhone(db, JEREMY))!.id, "solana"))!.address, 2_000_000n);
    expect(await say(JEREMY, "send @alex $5")).toMatch(/^You have \$2 in test USDC, not enough for that one\./);
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
    expect(sms.last(NEWBIE)).toMatch(/^alex sent you \$5 USDC on Dial\. Reply to this text to claim it\. See it: https:\/\/tmc\.test\/a\/pi_/);
    expect(sms.last(NEWBIE)).toMatch(/ Dial operator: msg & data rates may apply\. Reply STOP to opt out\.$/);

    expect(await say(NEWBIE, "hey")).toBe(
      "hi, I'm the Dial operator by Dial.Work. alex sent you $5 USDC and it's waiting for you. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Terms: https://tmc.test/terms\nWhat name should people use to pay you?",
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

describe("send to someone not on Dial (escrow program)", () => {
  let esc: ReturnType<typeof fakeEscrow>;

  beforeEach(async () => {
    esc = fakeEscrow();
    sol = fakeAdapter({ defaultBalance: 100_000_000n, escrow: esc });
    deps = { ...deps, adapters: { solana: sol } };
    await signUp(ALEX, "alex");
  });

  async function sendToNewbie(amount = "5") {
    const confirm = await say(ALEX, `send $${amount} to (555) 000-0099`);
    await say(ALEX, codeIn(confirm));
    return intentIdIn(confirm);
  }

  async function claimAsRiley() {
    await say(NEWBIE, "hey");
    await say(NEWBIE, "riley");
    const offer = sms.to(NEWBIE).find((m) => m.startsWith("alex sent you $5 USDC. Reply")) ?? "";
    await say(NEWBIE, codeIn(offer));
  }

  it("funds the program's vault for the intent instead of a server-held wallet", async () => {
    const id = await sendToNewbie();
    const intent = await getIntent(db, id);
    const expires = new Date(clock.getTime() + 7 * 86_400_000);
    expect(intent).toMatchObject({
      status: "escrowed",
      escrowProgram: esc.programId,
      escrowSecretEnc: null,
      recipientAddress: `vault_${id}`,
      escrowExpiresAt: expires,
      txHash: `sig_create_${id}`,
    });
    expect(esc.calls).toEqual([{ op: "create", intentId: id, amount: 5_000_000n, expiresAt: expires }]);
    expect(sol.settled).toEqual([]);
    expect(sms.last(ALEX)).toBe('Sent $5 to +•••••••0099. They have 7 days to claim it. If they don\'t, text "reclaim" to get it back.');
  });

  it("claims with the attestor once the recipient proves their phone with the texted code", async () => {
    const id = await sendToNewbie();
    await claimAsRiley();
    const riley = await findUserByPhone(db, NEWBIE);
    const rw = await getWallet(db, riley!.id, "solana");
    expect(esc.calls.at(-1)).toEqual({ op: "claim", intentId: id, to: rw!.address });
    expect(sms.last(NEWBIE)).toMatch(/^Claimed \$5 from alex\. Receipt: https:\/\/explorer\.test\/sig_claim_/);
    expect(sms.last(ALEX)).toBe("riley claimed the $5 you sent.");
    expect(await getIntent(db, id)).toMatchObject({ status: "settled", releaseTxHash: `sig_claim_${id}` });
  });

  it("when a claim doesn't go through, says so and texts a fresh code that works", async () => {
    const id = await sendToNewbie();
    esc.fail.next = new Error("Transaction simulation failed");
    await claimAsRiley();
    expect(await getIntent(db, id)).toMatchObject({ status: "escrowed", error: "Transaction simulation failed" });
    const reply = sms.last(NEWBIE);
    expect(reply).toMatch(
      /^Couldn't confirm your claim of the \$5 from alex yet\. Reply \d{6} to finish it: if it already went through, you'll just get the receipt\.$/,
    );

    await say(NEWBIE, codeIn(reply));
    expect(sms.last(NEWBIE)).toMatch(/^Claimed \$5 from alex\. Receipt: /);
    expect(await getIntent(db, id)).toMatchObject({ status: "settled", releaseTxHash: `sig_claim_${id}` });
  });

  it("after expiry, tells the recipient it can only go back to the sender and doesn't try the claim", async () => {
    const id = await sendToNewbie();
    await say(NEWBIE, "hey");
    await say(NEWBIE, "riley");
    const offer = sms.to(NEWBIE).find((m) => m.startsWith("alex sent you $5 USDC. Reply")) ?? "";
    clock = new Date(clock.getTime() + 7 * 86_400_000 + 60_000);

    expect(await say(NEWBIE, codeIn(offer))).toBe(
      "The $5 from alex wasn't claimed in time, so it can only go back to them now. Ask them to send it again.",
    );
    expect(esc.calls.map((c) => c.op)).toEqual(["create"]);
    expect((await getIntent(db, id))?.status).toBe("escrowed");

    // Refunds wait a few minutes past expiry: the chain's clock can trail ours.
    expect(await say(ALEX, "reclaim")).toBe("Nothing to reclaim right now. Unclaimed payments can come back after 7 days.");
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await say(ALEX, "reclaim")).toBe("Got back $5 from 1 unclaimed payment.");
  });

  it("doesn't offer an expired escrow to someone who joins after it expired", async () => {
    const id = await sendToNewbie();
    clock = new Date(clock.getTime() + 8 * 86_400_000);
    expect(await say(NEWBIE, "hey")).not.toMatch(/waiting for you/);
    await say(NEWBIE, "riley");
    expect(sms.to(NEWBIE).some((m) => /Reply \d{6} to claim it/.test(m))).toBe(false);
    expect(await say(ALEX, "reclaim")).toBe("Got back $5 from 1 unclaimed payment.");
    expect(await getIntent(db, id)).toMatchObject({ status: "refunded", releaseTxHash: `sig_refund_${id}` });
  });

  it("says the same when the program itself refuses because the escrow expired", async () => {
    const id = await sendToNewbie();
    esc.fail.next = new EscrowExpiredError(id);
    await claimAsRiley();
    expect(sms.last(NEWBIE)).toBe(
      "The $5 from alex wasn't claimed in time, so it can only go back to them now. Ask them to send it again.",
    );
    expect((await getIntent(db, id))?.status).toBe("escrowed");
  });

  it("refunds through the program only after expiry", async () => {
    const id = await sendToNewbie("4");
    expect(await say(ALEX, "reclaim")).toBe("Nothing to reclaim right now. Unclaimed payments can come back after 7 days.");
    clock = new Date(clock.getTime() + 8 * 86_400_000);
    expect(await say(ALEX, "reclaim")).toBe("Got back $4 from 1 unclaimed payment.");
    expect(esc.calls.at(-1)).toEqual({ op: "refund", intentId: id });
    expect(await getIntent(db, id)).toMatchObject({ status: "refunded", releaseTxHash: `sig_refund_${id}` });
  });

  /** What the chain shows for a funded escrow: the sender's wallet, the amount, and the funding transaction. */
  async function onChain(id: string, amount = 5_000_000n) {
    const wallet = await getWallet(db, (await findUserByPhone(db, ALEX))!.id, "solana");
    esc.chain.set(id, {
      state: "open",
      sender: wallet!.address,
      amount,
      expiresAt: new Date(clock.getTime() + 7 * 86_400_000),
      funded: { txHash: `sig_create_${id}`, explorerUrl: `https://explorer.test/sig_create_${id}` },
    });
  }

  /** A payment approved by a worker that died before it finished: settling, no error, no funding transaction. */
  async function approvedThenDied() {
    const confirm = await say(ALEX, "send $5 to (555) 000-0099");
    const id = intentIdIn(confirm);
    await claimForSettlement(db, id, clock);
    return id;
  }

  it("a funding that landed after we stopped waiting is settled from the chain, and both people hear", async () => {
    esc.fail.next = new EscrowUnconfirmedError("pi", new Error("Solana tx not confirmed in time"));
    const id = await sendToNewbie();
    expect(await getIntent(db, id)).toMatchObject({ status: "settling", txHash: null });
    expect(sms.last(ALEX)).toBe(
      "Your $5 to +•••••••0099 is taking longer than usual to confirm. I'll text you as soon as it does, so don't send it again.",
    );
    await onChain(id);

    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 1, failed: 0 });
    expect(await getIntent(db, id)).toMatchObject({ status: "escrowed", txHash: `sig_create_${id}`, error: null });
    expect(sms.last(ALEX)).toMatch(/^Sent \$5 to \+•••••••0099\. They have 7 days to claim it\./);
    expect(sms.last(NEWBIE)).toMatch(/^alex sent you \$5 USDC on Dial\. Reply to this text to claim it\./);
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 0 });

    await claimAsRiley();
    expect((await getIntent(db, id))?.status).toBe("settled");
  });

  it("a payment whose worker died mid-send is picked up after 5 minutes and settled from the chain", async () => {
    const id = await approvedThenDied();
    await onChain(id);
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 0 });
    clock = new Date(clock.getTime() + 6 * 60_000);
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 1, failed: 0 });
    expect(await getIntent(db, id)).toMatchObject({ status: "escrowed", txHash: `sig_create_${id}` });
    expect(sms.last(NEWBIE)).toMatch(/^alex sent you \$5 USDC on Dial\./);
  });

  it("a payment whose worker died before anything landed fails 15 minutes after approval", async () => {
    clock = new Date(clock.getTime() - 9 * 60_000);
    const id = await approvedThenDied();
    clock = new Date(clock.getTime() + 9 * 60_000);
    // Created and approved 9 minutes ago: picked up, but nothing to conclude yet.
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 0 });
    clock = new Date(clock.getTime() + 7 * 60_000);
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 1 });
    expect((await getIntent(db, id))?.status).toBe("failed");
    expect(sms.last(ALEX)).toBe("That payment didn't go through. No funds moved.");
  });

  it("never records an escrow that isn't this payment's (wrong amount or sender)", async () => {
    esc.fail.next = new EscrowUnconfirmedError("pi", new Error("timeout"));
    const id = await sendToNewbie();
    await onChain(id, 4_000_000n);
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 0 });
    esc.chain.set(id, { ...(esc.chain.get(id) as Extract<EscrowLookup, { state: "open" }>), amount: 5_000_000n, sender: "SomeoneElse111" });
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 0 });
    expect((await getIntent(db, id))?.status).toBe("settling");
  });

  it("a funding the chain never saw fails after 15 minutes, not before", async () => {
    esc.fail.next = new EscrowUnconfirmedError("pi", new Error("Solana tx not confirmed in time"));
    const id = await sendToNewbie();
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 0 });
    expect((await getIntent(db, id))?.status).toBe("settling");

    clock = new Date(clock.getTime() + 16 * 60_000);
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 1 });
    expect((await getIntent(db, id))?.status).toBe("failed");
    expect(sms.last(ALEX)).toBe("That payment didn't go through. No funds moved.");
  });

  it("a claim that landed after we stopped waiting is recorded when the sender tries to reclaim", async () => {
    const id = await sendToNewbie();
    esc.fail.next = new Error("Solana tx not confirmed in time");
    esc.fail.landed = true;
    await claimAsRiley();
    expect((await getIntent(db, id))?.status).toBe("escrowed");

    clock = new Date(clock.getTime() + 8 * 86_400_000);
    expect(await say(ALEX, "reclaim")).toBe("Nothing to reclaim right now. Unclaimed payments can come back after 7 days.");
    expect(await getIntent(db, id)).toMatchObject({ status: "settled", releaseTxHash: `sig_claim_${id}` });
    expect(sms.to(ALEX)).toContain("riley claimed the $5 you sent.");
    expect(sms.last(NEWBIE)).toMatch(/^Claimed \$5 from alex\. Receipt: https:\/\/explorer\.test\/sig_claim_/);
  });

  it("a refund someone else sent is recorded when the recipient tries to claim", async () => {
    const id = await sendToNewbie();
    esc.chain.set(id, { state: "refunded", result: { txHash: "sig_crank", explorerUrl: "https://explorer.test/sig_crank" } });
    await claimAsRiley();
    expect(sms.last(NEWBIE)).toBe(
      "The $5 from alex wasn't claimed in time, so it can only go back to them now. Ask them to send it again.",
    );
    expect(await getIntent(db, id)).toMatchObject({ status: "refunded", releaseTxHash: "sig_crank" });
    expect(sms.last(ALEX)).toBe("Got back $5 from 1 unclaimed payment.");
  });

  it("won't move a program escrow through a server wallet when the program is switched off", async () => {
    const id = await sendToNewbie();
    deps = { ...deps, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }) } };
    await claimAsRiley();
    const intent = await getIntent(db, id);
    expect(intent?.status).toBe("escrowed");
    expect(intent?.error).toMatch(/Escrow program .* is not available on solana/);
    expect(sms.last(NEWBIE)).toMatch(/^Couldn't confirm your claim of the \$5 from alex yet\./);
  });

  it("still pays people already on Dial directly", async () => {
    await signUp(JEREMY, "jeremy");
    const confirm = await say(ALEX, "send @jeremy $2");
    await say(ALEX, codeIn(confirm));
    expect(esc.calls).toEqual([]);
    expect(sol.settled).toHaveLength(1);
  });
});

describe("request and invoice", () => {
  beforeEach(async () => {
    await signUp(ALEX, "alex");
    await signUp(JEREMY, "jeremy");
  });

  it("texts the payer a code, and paying it notifies the requester", async () => {
    expect(await say(JEREMY, "request $25 from @alex for pizza")).toBe("Asked @alex for $25. I'll text you when they pay.");
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

describe("directory", () => {
  const JP = "+15550000020";
  const JK = "+15550000021";
  beforeEach(async () => {
    await signUp(ALEX, "Alex");
    await signUp(JP, "Jeremy Meyer");
    await signUp(JK, "Jeremy King");
  });

  it("looks people up with 411 without revealing numbers", async () => {
    const r = await say(ALEX, "411 jeremy");
    expect(r).toMatch(/^Directory for "jeremy": @jeremymeyer \(Jeremy Meyer\) · @jeremyking \(Jeremy King\)\./);
    expect(r).not.toContain("555");
    expect(await say(ALEX, "who is nobody")).toMatch(/^No one matching "nobody"/);
  });

  it("asks which one when a name matches several people, then connects the pick", async () => {
    expect(await say(ALEX, "send jeremy $3")).toBe(
      'I found 2 people for "jeremy": 1) @jeremymeyer (Jeremy Meyer)  2) @jeremyking (Jeremy King). Reply 1 or 2, or their number.',
    );
    expect(await say(ALEX, "2")).toMatch(/^Send \$3 USDC to @jeremyking \(Jeremy King\) on Solana\? Reply \d{6}/);
  });

  it("connects directly on a single directory match", async () => {
    expect(await say(ALEX, "send king $1")).toMatch(/^Send \$1 USDC to @jeremyking \(Jeremy King\)/);
  });

  it("renames and reports who you are", async () => {
    expect(await say(ALEX, "call me Alex the Great, obviously")).toBe("Done. You're Alex the Great now, still @alex.");
    expect(await say(ALEX, "whoami")).toBe('You\'re Alex the Great, @alex. People can text me "send @alex $5".');
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

  describe("a 0x address on a Solana account", () => {
    const EVM_OUT = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb";
    // Like the real adapters: Solana takes base58 only, the EVM-style chains 0x only.
    const solanaOnly = (a: FakeAdapter): FakeAdapter => Object.assign(a, { isValidAddress: (x: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x) });
    const evm = (chain: "ethereum" | "robinhood" | "tempo"): FakeAdapter =>
      Object.assign(fakeAdapter({ chain, defaultBalance: 100_000_000n }), { isValidAddress: (x: string) => /^0x[0-9a-fA-F]{40}$/.test(x) });

    it("says it isn't a Solana address when no EVM-style chain is on", async () => {
      deps = { ...deps, adapters: { solana: solanaOnly(sol) } };
      expect(await say(ALEX, `withdraw all to ${EVM_OUT}`)).toBe("That doesn't look like a Solana address. Check it and try again.");
    });

    it("uses the only EVM-style chain that's on", async () => {
      deps = { ...deps, adapters: { solana: solanaOnly(sol), ethereum: evm("ethereum") } };
      expect(await say(ALEX, `withdraw $5 to ${EVM_OUT}`)).toMatch(/^Withdraw \$5 USDC to 0x742d…bEbb on Ethereum\? Reply \d{6} to confirm/);
    });

    it("asks which chain when several fit, and takes the answer", async () => {
      deps = { ...deps, adapters: { solana: solanaOnly(sol), tempo: evm("tempo"), ethereum: evm("ethereum"), robinhood: evm("robinhood") } };
      expect(await say(ALEX, `withdraw $5 to ${EVM_OUT}`)).toBe("Which chain: ethereum, robinhood, tempo?");
      expect(await say(ALEX, "robinhood")).toMatch(/^Withdraw \$5 USDC to 0x742d…bEbb on Robinhood Chain\? Reply \d{6} to confirm/);
      // The question is used up: the chain name alone is now just chat.
      expect(await say(ALEX, "robinhood")).not.toMatch(/^Withdraw/);
    });
  });

  it("looks at every chain before saying there's nothing to withdraw", async () => {
    const tempo = fakeAdapter({ chain: "tempo" });
    deps = { ...deps, adapters: { solana: sol, tempo } };
    const alex = (await findUserByPhone(db, ALEX))!;
    sol.balances.set((await getWallet(db, alex.id, "solana"))!.address, 0n);
    expect(await say(ALEX, `withdraw all to ${OUT}`)).toBe("Your balance is $0. Nothing to withdraw.");

    tempo.balances.set((await ensureWallet(deps, alex.id, "tempo", tempo)).address, 5_000_000n);
    expect(await say(ALEX, `withdraw all to ${OUT}`)).toBe(
      'Your Solana balance is $0. You have $5 on Tempo. To move it, text "withdraw all to <address> on tempo".',
    );
  });
});

describe("not enough money", () => {
  beforeEach(async () => {
    await signUp(ALEX, "alex");
    await signUp(JEREMY, "jeremy");
    sol.balances.set((await getWallet(db, (await findUserByPhone(db, JEREMY))!.id, "solana"))!.address, 2_000_000n);
  });

  it("points to their pay page and, on a Circle testnet, the faucet", async () => {
    expect(await say(JEREMY, "send @alex $5")).toBe(
      "You have $2 in test USDC, not enough for that one. Add more: https://tmc.test/@jeremy Free test USDC: faucet.circle.com",
    );
  });

  it("leaves the Circle faucet out where it has no test USDC", async () => {
    const tempo = fakeAdapter({ chain: "tempo", defaultBalance: 0n });
    deps = { ...deps, adapters: { solana: sol, tempo }, dripAmount: 0n };
    expect(await say(JEREMY, "send @alex $5 on tempo")).toBe(
      "You have $0 in test USDC, not enough for that one. Add more: https://tmc.test/@jeremy",
    );
  });

  it("on mainnet, just the pay page", async () => {
    deps = { ...deps, network: "mainnet" };
    expect(await say(JEREMY, "send @alex $5")).toBe("You have $2 USDC, not enough for that one. Add more: https://tmc.test/@jeremy");
  });
});

describe("passkey accounts", () => {
  beforeEach(async () => {
    await signUp(ALEX, "alex");
    await signUp(JEREMY, "jeremy");
    const alex = await findUserByPhone(db, ALEX);
    await db.insert(passkeys).values({ id: "cred1", userId: alex!.id, publicKey: "pk" });
  });

  it("requires the passkey above the threshold and issues no code", async () => {
    const confirm = await say(ALEX, "send @jeremy $25");
    expect(confirm).toMatch(/^Send \$25 USDC to @jeremy on Solana\? Approve with your passkey: https:\/\/tmc\.test\/a\/pi_/);
    expect(codeIn(confirm)).toBe("");
    expect(await say(ALEX, "123456")).toBe("Nothing is waiting on a code right now.");
  });

  it("still allows texted codes for small payments", async () => {
    expect(await say(ALEX, "send @jeremy $5")).toMatch(/Reply \d{6} to confirm/);
  });

  it("asks a passkey payer to use it for large requests", async () => {
    await say(JEREMY, "request $30 from @alex");
    expect(sms.last(ALEX)).toMatch(/^jeremy is asking you for \$30 USDC\. Pay with your passkey or decline: /);
  });
});

describe("balance, receive, upgrade, chat", () => {
  beforeEach(async () => {
    await signUp(ALEX, "alex");
  });

  it("answers balance and receive", async () => {
    expect(await say(ALEX, "balance")).toBe("You have $100 USDC on Solana.");
    expect(await say(ALEX, "receive")).toBe(
      'Your pay link: https://tmc.test/@alex Anyone can pay you there, or text me "send alex $5". To deposit, send USDC to Solana: solanaAddr1',
    );
  });

  it("texts a one-time wallet link and code", async () => {
    const reply = await say(ALEX, "wallet");
    expect(reply).toMatch(/^Your wallet: https:\/\/tmc\.test\/wallet\/in\/[\w-]{32} Enter \d{6} there to open it\./);
  });

  it("offers a passkey upgrade link", async () => {
    expect(await say(ALEX, "upgrade")).toMatch(
      /^Add a passkey for one-tap approvals and higher limits: open https:\/\/tmc\.test\/s\/[\w-]+ and enter \d{6}\. The link works once, for 15 minutes\.$/,
    );
  });

  it("chats", async () => {
    expect(await say(ALEX, "yo what is this")).toMatch(/Dial operator/);
  });
});

describe("chains", () => {
  it("opens a wallet on another chain on first use and drops the test bonus there", async () => {
    const tempo = fakeAdapter({ chain: "tempo", defaultBalance: 100_000_000n });
    deps = { ...deps, adapters: { solana: sol, tempo } };
    await signUp(ALEX, "alex");
    await signUp(JEREMY, "jeremy");
    const alex = await findUserByPhone(db, ALEX);
    expect(await getWallet(db, alex!.id, "tempo")).toBeNull();
    expect(await say(ALEX, "send @jeremy $1 on tempo")).toMatch(/^Send \$1 USDC to @jeremy on Tempo\? Reply \d{6}/);
    const w = await getWallet(db, alex!.id, "tempo");
    expect(tempo.funded).toEqual([`${w!.address}:25000000`]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { type BotDeps, handleInbound } from "@/lib/bot/handle-inbound";
import type { Db } from "@/lib/db/client";
import { createUnclaimedUser, createUser, findUserByPhone } from "@/lib/identity";
import { createIntent, getIntent } from "@/lib/intents";
import type { InboundSms } from "@/lib/sms/inbound";
import { addWallet, getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, silentLlm, smsSink } from "../helpers/fakes";

const key = Buffer.alloc(32, 9).toString("base64");
const ALEX = "+15550000010";
const JEREMY = "+15550000011";
let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let k = 0;
const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `k${++k}` });
const say = async (from: string, body: string) => (await handleInbound(deps, msg(from, body)))[0] ?? "";

async function seedUser(phone: string, handle: string, address: string) {
  const u = await createUser(db, { phone, handle });
  await addWallet(db, { userId: u.id, chain: "solana", address, secret: new Uint8Array(32), keyB64: key });
  return u;
}

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  deps = {
    db,
    sendSms: sms.sendSms,
    llm: silentLlm,
    adapters: { solana: fakeAdapter({ AddrAlex: 100_000_000n }) },
    appUrl: "https://tmc.test",
    now: () => new Date("2026-10-09T12:00:00Z"),
    perTxCap: 50_000_000n,
    walletKey: key,
  };
});

describe("first contact", () => {
  it("greets an unknown number with a signup link", async () => {
    const reply = await say("+15550000001", "hi");
    expect(reply).toMatch(/^hi, I'm the Dial operator\. I can help you text your crypto\./);
    expect(reply).toMatch(/https:\/\/tmc\.test\/s\/[\w-]+/);
  });

  it("ignores a duplicate delivery", async () => {
    const m = msg("+15550000001", "hi");
    await handleInbound(deps, m);
    expect(await handleInbound(deps, m)).toEqual([]);
  });

  it("tells an unclaimed recipient that money is waiting", async () => {
    const alex = await seedUser(ALEX, "alex", "AddrAlex");
    const u = await createUnclaimedUser(db, "+15550000077");
    await addWallet(db, { userId: u.id, chain: "solana", address: "AddrU", secret: new Uint8Array(32), keyB64: key });
    const i = await createIntent(
      db,
      { kind: "send", createdBy: alex.id, senderId: alex.id, recipientId: u.id, chain: "solana", token: "Mint111", recipientAddress: "AddrU", amount: 7_000_000n, note: null },
      deps.now(),
    );
    const { markSettled } = await import("@/lib/intents");
    await markSettled(db, i.id, { txHash: "s", explorerUrl: "https://x/s" });
    expect(await say("+15550000077", "hey")).toMatch(/^hi, I'm the Dial operator\. alex sent you \$7 USDC and it's waiting for you\. Claim it here: https:\/\/tmc\.test\/s\//);
  });
});

describe("send", () => {
  beforeEach(async () => {
    await seedUser(ALEX, "alex", "AddrAlex");
    await seedUser(JEREMY, "jeremy", "AddrJeremy");
  });

  it("turns a send into an approval link", async () => {
    const reply = await say(ALEX, "send jeremy $10 for pizza");
    expect(reply).toMatch(/^Send \$10 USDC to jeremy \(pizza\) on Solana\? Approve: https:\/\/tmc\.test\/a\/pi_[\w-]+$/);
    expect(sms.to(ALEX)).toHaveLength(1);
  });

  it("sends to a phone number that has never used Dial by creating a waiting wallet", async () => {
    const reply = await say(ALEX, "send $5 to (555) 000-0099");
    expect(reply).toMatch(/^Send \$5 USDC to \+•••••••0099 on Solana\? Approve: /);
    const u = await findUserByPhone(db, "+15550000099");
    expect(u?.handle).toBeNull();
    expect(await getWallet(db, u!.id, "solana")).not.toBeNull();
    expect(sms.to("+15550000099")).toEqual([]);
  });

  it("rejects unknown names, self-sends, over-cap and insufficient balance", async () => {
    expect(await say(ALEX, "send nobody $1")).toMatch(/don't know nobody/);
    expect(await say(ALEX, "send alex $1")).toMatch(/That's you/);
    expect(await say(ALEX, "send jeremy $51")).toMatch(/caps payments at \$50/);
    expect(await say(JEREMY, "send alex $5")).toMatch(/You have \$0/);
  });

  it("says when a chain isn't on yet", async () => {
    expect(await say(ALEX, "send jeremy $1 on tempo")).toBe("Tempo isn't switched on yet. Try Solana.");
  });
});

describe("request and invoice", () => {
  beforeEach(async () => {
    await seedUser(ALEX, "alex", "AddrAlex");
    await seedUser(JEREMY, "jeremy", "AddrJeremy");
  });

  it("request texts the payer a pay link and confirms to the requester", async () => {
    const reply = await say(JEREMY, "request $25 from alex for pizza");
    expect(reply).toBe("Asked alex for $25. I'll text you when they pay.");
    const [toPayer] = sms.to(ALEX);
    expect(toPayer).toMatch(/^jeremy is asking you for \$25 USDC \(pizza\)\. Pay or decline: https:\/\/tmc\.test\/a\/(pi_[\w-]+)$/);
    const id = /\/a\/(pi_[\w-]+)$/.exec(toPayer ?? "")?.[1] ?? "";
    const intent = await getIntent(db, id);
    expect(intent).toMatchObject({ kind: "request", recipientAddress: "AddrJeremy", amount: 25_000_000n, note: "pizza" });
  });

  it("invoice texts the payer and returns a tracking link", async () => {
    const reply = await say(JEREMY, "invoice alex $40 for logo design");
    expect(reply).toMatch(/^Invoice for \$40 sent to alex\. Track it: https:\/\/tmc\.test\/a\/pi_/);
    expect(sms.to(ALEX)[0]).toMatch(/^jeremy sent you an invoice for \$40 USDC \(logo design\)\. Pay: /);
  });

  it("can request from a number that has never used Dial", async () => {
    await say(JEREMY, "request $8 from +1 555 000 0123");
    expect(sms.to("+15550000123")[0]).toMatch(/^jeremy is asking you for \$8 USDC\. Pay or decline: /);
  });
});

describe("balance, receive, chat", () => {
  beforeEach(async () => {
    await seedUser(ALEX, "alex", "AddrAlex");
  });

  it("answers balance", async () => {
    expect(await say(ALEX, "balance")).toBe("You have $100 USDC on Solana.");
  });

  it("answers receive with name and address", async () => {
    expect(await say(ALEX, "receive")).toBe('People can text me "send alex $5". Or send USDC to Solana: AddrAlex');
  });

  it("chats", async () => {
    expect(await say(ALEX, "yo what is this")).toMatch(/Dial operator/);
  });
});

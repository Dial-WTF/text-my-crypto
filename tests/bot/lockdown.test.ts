import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { intents } from "@/lib/db/schema";
import { findUserByPhone } from "@/lib/identity";
import { getIntent } from "@/lib/intents";
import type { InboundSms } from "@/lib/sms/inbound";
import { createSession, sessionUser } from "@/lib/web/sessions";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let k = 0;

const say = async (body: string) => {
  const msg: InboundSms = { to: "+18066071387", from: ALEX, body, dedupeKey: `l${++k}` };
  await handleInbound(deps, msg);
  return sms.last(ALEX);
};

async function signedInSession(): Promise<string> {
  const user = await findUserByPhone(db, ALEX);
  if (!user) throw new Error("no user");
  return createSession(db, user.id, "text", deps.now());
}

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }) } });
  await say("hi");
  await say("Alex");
});

describe("locking an account down by text", () => {
  it("STOP also signs them out of the wallet on the web", async () => {
    const token = await signedInSession();
    expect(await sessionUser(db, token, deps.now())).not.toBeNull();
    await say("STOP");
    expect(await sessionUser(db, token, deps.now())).toBeNull();
  });

  it("revoke agents also ends web sessions, and says so", async () => {
    const token = await signedInSession();
    expect(await say("revoke agents")).toBe(
      'No agents are connected. Text "connect agent" to connect one. I also signed you out of your wallet on the web.',
    );
    expect(await sessionUser(db, token, deps.now())).toBeNull();
    expect(await say("revoke agents")).toBe('No agents are connected. Text "connect agent" to connect one.');
  });
});

describe("coming back with START", () => {
  it("doesn't buy more tries: guesses already made still count, and a locked request isn't offered again", async () => {
    const JEREMY = "+15550000011";
    const jeremy = async (body: string) => {
      await handleInbound(deps, { to: "+18066071387", from: JEREMY, body, dedupeKey: `l${++k}` });
      return sms.last(JEREMY);
    };
    await jeremy("hi");
    await jeremy("Jeremy");
    await say("request $5 from @jeremy for lunch");
    await say("request $6 from @jeremy for gas");
    const [lunch, gas] = await db.select().from(intents).where(eq(intents.kind, "request")).orderBy(intents.amount);
    // Someone guessing from a forged number: three wrong codes cost both requests three tries.
    for (let n = 0; n < 3; n++) await jeremy("000000");
    await db.update(intents).set({ codeAttempts: 5 }).where(eq(intents.id, lunch!.id));
    await jeremy("STOP");
    const before = sms.to(JEREMY).length;

    await jeremy("START");
    const offered = sms.to(JEREMY).slice(before);
    expect(offered.some((t) => t.includes("$5"))).toBe(false);
    expect(offered.filter((t) => /\$6.*Reply \d{6} to pay/.test(t))).toHaveLength(1);
    expect((await getIntent(db, gas!.id))?.codeAttempts).toBe(3);
    expect((await getIntent(db, lunch!.id))?.codeAttempts).toBe(5);
  });

  it("offers what was asked of them while they were away, with a fresh code", async () => {
    const JEREMY = "+15550000011";
    const from = (phone: string) => async (body: string) => {
      await handleInbound(deps, { to: "+18066071387", from: phone, body, dedupeKey: `l${++k}` });
      return sms.last(phone);
    };
    const jeremy = from(JEREMY);
    await jeremy("hi");
    await jeremy("Jeremy");
    await jeremy("STOP");
    const before = sms.to(JEREMY).length;

    await say("request $5 from @jeremy for lunch");
    expect(sms.to(JEREMY)).toHaveLength(before);

    await jeremy("START");
    const [welcome, request] = sms.to(JEREMY).slice(-2);
    expect(welcome).toMatch(/^Welcome back\./);
    expect(request).toMatch(/^Alex is asking you for \$5 USDC \(lunch\)\. Reply \d{6} to pay or NO to decline/);
  });
});

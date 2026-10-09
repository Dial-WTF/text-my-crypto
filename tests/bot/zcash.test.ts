import { beforeEach, describe, expect, it } from "vitest";
import { dripOnce, ensureWallet } from "@/lib/bot/accounts";
import { handleInbound } from "@/lib/bot/handle-inbound";
import { resumeUnknownSettlements } from "@/lib/bot/settle";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { findUserByPhone } from "@/lib/identity";
import { claimUnknownForRetry, getIntent } from "@/lib/intents";
import { SettlementUnknownError } from "@/lib/settlement/unconfirmed";
import type { InboundSms } from "@/lib/sms/inbound";
import { getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000020";
const JEREMY = "+15550000021";

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let zec: FakeAdapter & { failNext?: () => Error; escrowFlags: boolean[] };
let k = 0;

const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `z${++k}` });
const say = async (from: string, body: string) => {
  await handleInbound(deps, msg(from, body));
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";
const intentIdIn = (s: string) => /\/a\/(pi_[\w-]+)/.exec(s)?.[1] ?? "";

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  const base = fakeAdapter({ chain: "zcash", defaultBalance: 5_000_000n });
  const settle = base.settle;
  zec = Object.assign(base, { escrowFlags: [] as boolean[] });
  // Records every attempt like the fake does, then fails it once if a test asked for that.
  zec.settle = async (args) => {
    zec.escrowFlags.push(args.escrow ?? false);
    const r = await settle(args);
    const fail = zec.failNext;
    zec.failNext = undefined;
    if (fail) throw fail();
    return r;
  };
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

  it("passes the escrow flag when the recipient isn't on Dial yet", async () => {
    const confirm = await say(ALEX, "send +15550000029 $1 on zcash");
    await say(ALEX, codeIn(confirm));
    expect(zec.settled).toHaveLength(1);
    expect(zec.escrowFlags).toEqual([true]);
  });
});

describe("Zcash network fees", () => {
  it("says the fees are short when the balance covers the amount but not what an escrow send carries", async () => {
    zec.carriedFees = (to) => (to === "escrow" ? 10_000n : to === "dial" ? 5_000n : 0n);
    const reply = await say(ALEX, "send +15550000029 $5 on zcash");
    expect(reply).toBe(
      "You have $5 (0.1 TAZ), but on Zcash that payment also needs $0.01 (0.0002 TAZ) for network fees, so I didn't send it. Nothing moved. Try a little less.",
    );
    expect(zec.settled).toHaveLength(0);
  });

  it("lets the same balance pay a little less", async () => {
    zec.carriedFees = (to) => (to === "escrow" ? 10_000n : 0n);
    const confirm = await say(ALEX, "send +15550000029 $4.99 on zcash");
    expect(confirm).toMatch(/^Send \$4\.99 \(0\.0998 TAZ\)/);
  });
});

describe("a Zcash send whose answer never came back", () => {
  it("stays settling, tells the sender it may still land, and the resume job finishes it", async () => {
    zec.failNext = () => new SettlementUnknownError("zcash", new Error("504 gateway timeout"));
    const confirm = await say(ALEX, "send @jeremy $1 on zcash");
    const id = intentIdIn(confirm);
    await say(ALEX, codeIn(confirm));
    expect((await getIntent(db, id))?.status).toBe("settling");
    expect(sms.to(ALEX).some((t) => t.includes("taking longer than usual to confirm"))).toBe(true);
    expect(sms.to(ALEX).some((t) => /didn't go through|failed/i.test(t))).toBe(false);

    const [outcome] = await resumeUnknownSettlements(deps);
    expect(outcome?.ok).toBe(true);
    expect((await getIntent(db, id))?.status).toBe("settled");
    // The retry carried the same memo, which is what makes it idempotent in the wallet service.
    expect(zec.settled.map((c) => c.memo)).toEqual([id, id]);
    expect(sms.to(JEREMY).some((t) => t.includes("$1 (0.02 TAZ)"))).toBe(true);
    expect(await resumeUnknownSettlements(deps)).toEqual([]);
  });

  it("picks a retry back up when the run that took it died", async () => {
    zec.failNext = () => new SettlementUnknownError("zcash", new Error("no answer"));
    const confirm = await say(ALEX, "send @jeremy $1 on zcash");
    const id = intentIdIn(confirm);
    await say(ALEX, codeIn(confirm));
    // A run takes it and dies before finishing: the marker stays.
    expect(await claimUnknownForRetry(db, id, deps.now())).not.toBeNull();
    expect(await resumeUnknownSettlements(deps)).toEqual([]);
    // Five minutes on, the stale claim is fair game again.
    const later = { ...deps, now: () => new Date(deps.now().getTime() + 6 * 60_000) };
    const [outcome] = await resumeUnknownSettlements(later);
    expect(outcome?.ok).toBe(true);
    expect((await getIntent(db, id))?.status).toBe("settled");
  });

  it("marks it failed only when the retry gets a definite no", async () => {
    zec.failNext = () => new SettlementUnknownError("zcash", new Error("no answer"));
    const confirm = await say(ALEX, "send @jeremy $1 on zcash");
    const id = intentIdIn(confirm);
    await say(ALEX, codeIn(confirm));
    zec.failNext = () => new Error("Zcash wallet service 422 rejected: expired");
    const [outcome] = await resumeUnknownSettlements(deps);
    expect(outcome?.ok).toBe(false);
    expect((await getIntent(db, id))?.status).toBe("failed");
  });

  it("keeps a drip taken when its answer never came back, so it is never sent twice", async () => {
    const alex = await findUserByPhone(db, ALEX);
    if (!alex) throw new Error("no alex");
    const w = await ensureWallet(deps, alex.id, "zcash", zec);
    zec.fund = async () => {
      throw new SettlementUnknownError("zcash", new Error("timeout"));
    };
    await expect(dripOnce(deps, w, zec)).rejects.toBeInstanceOf(SettlementUnknownError);
    expect((await getWallet(db, alex.id, "zcash"))?.drippedAt).not.toBeNull();
  });
});

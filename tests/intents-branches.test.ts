import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { hashCode } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import { intents } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import {
  createIntent,
  expiredEscrowForCode,
  getIntent,
  matchesExpiredCode,
  type NewIntent,
  newSplitId,
  sentSince,
  splitHash,
  splitLegs,
} from "@/lib/intents";
import { createTestDb } from "./helpers/db";

let db: Db;
const now = new Date("2026-10-09T12:00:00Z");
const later = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
let base: NewIntent;
let alexId: string;
let jeremyId: string;

beforeEach(async () => {
  db = await createTestDb();
  alexId = (await createUser(db, { phone: "+15550000110", handle: "alex" })).id;
  jeremyId = (await createUser(db, { phone: "+15550000111", handle: "jeremy" })).id;
  base = {
    kind: "send",
    createdBy: alexId,
    senderId: alexId,
    recipientId: jeremyId,
    chain: "solana",
    token: "Mint111",
    recipientAddress: "Dest111",
    amount: 10_000_000n,
    note: null,
  };
});

/** Puts a known code on an intent, the way issueCode would, without needing to know the random one. */
async function setCode(id: string, code: string): Promise<void> {
  await db.update(intents).set({ codeHash: await hashCode(id, code) }).where(eq(intents.id, id));
}

describe("intent lookups that come back empty", () => {
  it("getIntent returns null for an id that was never created", async () => {
    expect(await getIntent(db, "pi_nope")).toBeNull();
  });

  it("sentSince is zero for someone who has sent nothing", async () => {
    // Only Jeremy's incoming payment exists; Alex's spend counter must not see it as his.
    await createIntent(db, base, now);
    expect(await sentSince(db, jeremyId, new Date(0))).toBe(0n);
  });
});

describe("codes on expired payments", () => {
  it("matchesExpiredCode is false when the code belongs to no expired payment", async () => {
    const i = await createIntent(db, base, now);
    await setCode(i.id, "123456");
    expect(await matchesExpiredCode(db, alexId, "654321", later)).toBe(false);
    expect(await matchesExpiredCode(db, alexId, "123456", later)).toBe(true);
  });

  it("expiredEscrowForCode finds the expired escrow by its claim code, and nothing for a wrong code", async () => {
    const i = await createIntent(db, base, now);
    await db
      .update(intents)
      .set({ status: "escrowed", escrowExpiresAt: new Date(now.getTime() + 60_000) })
      .where(eq(intents.id, i.id));
    await setCode(i.id, "111222");
    expect(await expiredEscrowForCode(db, jeremyId, "999888", later)).toBeNull();
    expect((await expiredEscrowForCode(db, jeremyId, "111222", later))?.id).toBe(i.id);
    // Still live: an escrow that hasn't expired is not "expired" under any code.
    expect(await expiredEscrowForCode(db, jeremyId, "111222", now)).toBeNull();
  });
});

describe("splitHash", () => {
  it("binds the split id and every leg, so one approval covers exactly those payments", async () => {
    const splitId = newSplitId();
    await createIntent(db, { ...base, splitId }, now);
    await createIntent(db, { ...base, splitId, amount: 5_000_000n }, now);
    const legs = await splitLegs(db, splitId);
    expect(legs).toHaveLength(2);
    const h = await splitHash(legs);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await splitHash(legs)).toBe(h);
    // Change one leg's amount and the approval no longer covers it.
    const [first, second] = legs;
    if (!first || !second) throw new Error("legs missing");
    expect(await splitHash([first, { ...second, amount: second.amount + 1n }])).not.toBe(h);
    // Same legs in a different order are a different approval.
    expect(await splitHash([second, first])).not.toBe(h);
  });

  it("hashes an empty split without throwing, and differently from any real one", async () => {
    const empty = await splitHash([]);
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    const splitId = newSplitId();
    await createIntent(db, { ...base, splitId }, now);
    expect(await splitHash(await splitLegs(db, splitId))).not.toBe(empty);
  });
});

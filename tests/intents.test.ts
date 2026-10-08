import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { createUser } from "@/lib/identity";
import {
  canonicalIntent,
  claimForSettlement,
  createIntent,
  declineIntent,
  getIntent,
  intentHash,
  markFailed,
  markSettled,
  type NewIntent,
} from "@/lib/intents";
import { createTestDb } from "./helpers/db";

let db: Db;
const now = new Date("2026-10-09T12:00:00Z");
let base: NewIntent;

beforeEach(async () => {
  db = await createTestDb();
  const a = await createUser(db, { phone: "+15550000010", handle: "alex" });
  const j = await createUser(db, { phone: "+15550000011", handle: "jeremy" });
  base = {
    kind: "send",
    createdBy: a.id,
    senderId: a.id,
    recipientId: j.id,
    chain: "solana",
    token: "Mint111",
    recipientAddress: "Dest111",
    amount: 10_000_000n,
    note: null,
  };
});

describe("intents", () => {
  it("creates a pending intent with a 10 minute expiry for sends", async () => {
    const i = await createIntent(db, base, now);
    expect(i.status).toBe("pending");
    expect(i.kind).toBe("send");
    expect(i.expiresAt.getTime() - now.getTime()).toBe(10 * 60_000);
    expect(i.amount).toBe(10_000_000n);
  });

  it("gives requests and invoices a 7 day expiry and keeps the note", async () => {
    const r = await createIntent(db, { ...base, kind: "invoice", note: "logo design" }, now);
    expect(r.expiresAt.getTime() - now.getTime()).toBe(7 * 24 * 60 * 60_000);
    expect(r.note).toBe("logo design");
  });

  it("hash changes when any bound field changes", async () => {
    const i = await createIntent(db, base, now);
    const h = await intentHash(i);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await intentHash({ ...i, amount: 10_000_001n })).not.toBe(h);
    expect(await intentHash({ ...i, recipientAddress: "Other" })).not.toBe(h);
    expect(await intentHash({ ...i, senderId: "someone" })).not.toBe(h);
    expect(canonicalIntent(i)).toContain("dial-intent-v1");
  });

  it("can be claimed for settlement exactly once", async () => {
    const i = await createIntent(db, base, now);
    const [a, b] = await Promise.all([claimForSettlement(db, i.id, now), claimForSettlement(db, i.id, now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await getIntent(db, i.id))?.status).toBe("settling");
  });

  it("cannot be claimed after expiry", async () => {
    const i = await createIntent(db, base, now);
    expect(await claimForSettlement(db, i.id, new Date(now.getTime() + 11 * 60_000))).toBeNull();
  });

  it("records settlement, failure and decline", async () => {
    const i = await createIntent(db, base, now);
    await claimForSettlement(db, i.id, now);
    await markSettled(db, i.id, { txHash: "sig1", explorerUrl: "https://x/sig1" });
    expect(await getIntent(db, i.id)).toMatchObject({ status: "settled", txHash: "sig1" });

    const k = await createIntent(db, base, now);
    await markFailed(db, k.id, "boom");
    expect(await getIntent(db, k.id)).toMatchObject({ status: "failed", error: "boom" });

    const d = await createIntent(db, base, now);
    expect(await declineIntent(db, d.id)).toBe(true);
    expect(await declineIntent(db, d.id)).toBe(false);
    expect(await claimForSettlement(db, d.id, now)).toBeNull();
  });
});

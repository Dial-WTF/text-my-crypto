import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { createUser } from "@/lib/identity";
import {
  canonicalIntent,
  claimEscrowForRefund,
  claimEscrowForRelease,
  claimForSettlement,
  codeCandidates,
  createIntent,
  declineIntent,
  getIntent,
  intentHash,
  issueCode,
  markEscrowed,
  markFailed,
  markSettled,
  matchCode,
  type NewIntent,
  sentSince,
} from "@/lib/intents";
import { createTestDb } from "./helpers/db";

let db: Db;
const now = new Date("2026-10-09T12:00:00Z");
let base: NewIntent;
let alexId: string;
let jeremyId: string;

beforeEach(async () => {
  db = await createTestDb();
  alexId = (await createUser(db, { phone: "+15550000010", handle: "alex" })).id;
  jeremyId = (await createUser(db, { phone: "+15550000011", handle: "jeremy" })).id;
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

describe("intents", () => {
  it("creates sends with a 10 minute window and requests with 7 days", async () => {
    const s = await createIntent(db, base, now);
    expect(s.status).toBe("pending");
    expect(s.expiresAt.getTime() - now.getTime()).toBe(10 * 60_000);
    const r = await createIntent(db, { ...base, kind: "invoice", note: "logo design" }, now);
    expect(r.expiresAt.getTime() - now.getTime()).toBe(7 * 24 * 60 * 60_000);
    expect(r.note).toBe("logo design");
  });

  it("hash binds every field that matters", async () => {
    const i = await createIntent(db, base, now);
    const h = await intentHash(i);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [{ amount: 10_000_001n }, { recipientAddress: "Other" }, { senderId: "x" }, { recipientId: "y" }]) {
      expect(await intentHash({ ...i, ...change })).not.toBe(h);
    }
    expect(canonicalIntent(i)).toContain("dial-intent-v1");
  });

  it("can be claimed for settlement exactly once and not after expiry", async () => {
    const i = await createIntent(db, base, now);
    const [a, b] = await Promise.all([claimForSettlement(db, i.id, now), claimForSettlement(db, i.id, now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // The approval time is what the escrow reconciler measures its lease from.
    expect((a ?? b)?.approvedAt?.getTime()).toBe(now.getTime());
    expect((await getIntent(db, i.id))?.approvedAt?.getTime()).toBe(now.getTime());
    const late = await createIntent(db, base, now);
    expect(await claimForSettlement(db, late.id, new Date(now.getTime() + 11 * 60_000))).toBeNull();
  });

  it("records settlement, failure and decline", async () => {
    const i = await createIntent(db, base, now);
    await claimForSettlement(db, i.id, now);
    await markSettled(db, i.id, { txHash: "sig1", explorerUrl: "https://x/sig1" }, now);
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

describe("codes", () => {
  it("matches the right code for the sender's pending intent", async () => {
    const i = await createIntent(db, base, now);
    const code = await issueCode(db, i.id);
    expect(code).toMatch(/^\d{6}$/);
    const cands = await codeCandidates(db, alexId, now);
    expect(cands.map((c) => c.id)).toEqual([i.id]);
    expect(await codeCandidates(db, jeremyId, now)).toEqual([]);
    expect((await matchCode(db, cands, code)).map((c) => c.id)).toEqual([i.id]);
  });

  it("locks out after five wrong codes", async () => {
    const i = await createIntent(db, base, now);
    const code = await issueCode(db, i.id);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let n = 0; n < 5; n++) {
      expect(await matchCode(db, await codeCandidates(db, alexId, now), wrong)).toEqual([]);
    }
    expect(await codeCandidates(db, alexId, now)).toEqual([]);
  });

  it("offers escrowed intents to the recipient", async () => {
    const i = await createIntent(db, base, now);
    await claimForSettlement(db, i.id, now);
    await markEscrowed(db, i.id, { txHash: "f", explorerUrl: "https://x/f" }, new Date(now.getTime() + 1000));
    await issueCode(db, i.id);
    expect((await codeCandidates(db, jeremyId, now)).map((c) => c.id)).toEqual([i.id]);
  });
});

describe("escrow", () => {
  it("releases once, refunds only after expiry", async () => {
    const i = await createIntent(db, base, now);
    await claimForSettlement(db, i.id, now);
    const expires = new Date(now.getTime() + 7 * 86_400_000);
    await markEscrowed(db, i.id, { txHash: "f", explorerUrl: "https://x/f" }, expires);
    expect(await claimEscrowForRefund(db, i.id, now)).toBeNull();
    expect(await claimEscrowForRelease(db, i.id, expires)).toBeNull();
    expect(await claimEscrowForRelease(db, i.id, now)).not.toBeNull();
    expect(await claimEscrowForRelease(db, i.id, now)).toBeNull();

    const j = await createIntent(db, base, now);
    await claimForSettlement(db, j.id, now);
    await markEscrowed(db, j.id, { txHash: "f", explorerUrl: "https://x/f" }, expires);
    expect(await claimEscrowForRefund(db, j.id, new Date(expires.getTime() + 1))).not.toBeNull();
  });
});

describe("limits", () => {
  it("sums what a user has sent since a time", async () => {
    const i = await createIntent(db, base, now);
    await claimForSettlement(db, i.id, now);
    await createIntent(db, base, now);
    expect(await sentSince(db, alexId, new Date(now.getTime() - 1000))).toBe(10_000_000n);
    expect(await sentSince(db, jeremyId, new Date(0))).toBe(0n);
  });
});

import { describe, expect, it } from "vitest";
import { createUnclaimedUser, createUser } from "@/lib/identity";
import { claimForSettlement, createIntent, markEscrowed, markFailed, markSettled } from "@/lib/intents";
import { chainActivity, movedByChain, publicStats, recentPayments } from "@/lib/stats";
import { createTestDb } from "./helpers/db";

describe("public stats", () => {
  it("counts settled money and claimed people, and lists recent payments by handle only", async () => {
    const db = await createTestDb();
    const now = new Date("2026-10-09T12:00:00Z");
    const a = await createUser(db, { phone: "+15550000010", handle: "alex", name: "Alex Rivera" }, now);
    const j = await createUser(db, { phone: "+15550000011", handle: "jeremy" }, now);
    const u = await createUnclaimedUser(db, "+15550000099");
    const base = { kind: "send" as const, createdBy: a.id, senderId: a.id, chain: "solana" as const, token: "M", note: null };

    const one = await createIntent(db, { ...base, recipientId: j.id, recipientAddress: "J", amount: 10_000_000n }, now);
    await claimForSettlement(db, one.id, now);
    await markSettled(db, one.id, { txHash: "5HxSig", explorerUrl: "https://x/5HxSig" }, now);

    const later = new Date(now.getTime() + 60_000);
    const two = await createIntent(db, { ...base, recipientId: u.id, recipientAddress: "E", amount: 5_000_000n }, later);
    await claimForSettlement(db, two.id, later);
    await markEscrowed(db, two.id, { txHash: "E1", explorerUrl: "https://x/E1" }, later);

    await createIntent(db, { ...base, recipientId: j.id, recipientAddress: "J", amount: 1_000_000n }, now);

    expect(await publicStats(db)).toEqual({ payments: 2, movedUsd: 15_000_000n, people: 2 });
    const feed = await recentPayments(db, 8);
    expect(feed.map((p) => [p.from, p.to, p.amount, p.status])).toEqual([
      ["@alex", "someone new", 5_000_000n, "escrowed"],
      ["@alex", "@jeremy", 10_000_000n, "settled"],
    ]);
    // Public: no phone numbers, and no names people typed to get paid.
    expect(JSON.stringify(feed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/555|Rivera/);
  });
});

describe("chainActivity", () => {
  it("counts what moved on one chain (withdrawals too, like the live rule) and lists that chain's payments only", async () => {
    const db = await createTestDb();
    const now = new Date("2026-10-09T12:00:00Z");
    const a = await createUser(db, { phone: "+15550000020", handle: "alex" }, now);
    const j = await createUser(db, { phone: "+15550000021", handle: "jeremy" }, now);
    const send = { kind: "send" as const, createdBy: a.id, senderId: a.id, recipientId: j.id, recipientAddress: "0xJ", token: "T", note: null };
    let tick = 0;
    const moved = async (chain: "base" | "solana", kind: "send" | "withdraw" = "send") => {
      const at = new Date(now.getTime() + ++tick * 60_000);
      const i = await createIntent(db, { ...send, kind, chain, amount: 1_000_000n * BigInt(tick) }, at);
      await claimForSettlement(db, i.id, at);
      await markSettled(db, i.id, { txHash: `0x${tick}`, explorerUrl: `https://explorer.test/tx/0x${tick}` }, at);
      return i;
    };

    await moved("base");
    await moved("solana");
    await moved("base", "withdraw");
    const newest = await moved("base");
    const failed = await createIntent(db, { ...send, chain: "base", amount: 9_000_000n }, now);
    await claimForSettlement(db, failed.id, now);
    await markFailed(db, failed.id, "reverted");
    await createIntent(db, { ...send, chain: "base", amount: 7_000_000n }, now); // still pending

    const base = await chainActivity(db, "base", 5);
    expect(base.moved).toBe(3);
    expect(base.moved).toBe((await movedByChain(db)).base);
    // The withdrawal counts as moved money but isn't a payment between people, so it isn't listed.
    expect(base.recent.map((p) => [p.chain, p.amount, p.explorerUrl])).toEqual([
      ["base", 4_000_000n, "https://explorer.test/tx/0x4"],
      ["base", 1_000_000n, "https://explorer.test/tx/0x1"],
    ]);
    expect(base.recent[0]?.id).toBe(newest.id);
    expect((await chainActivity(db, "base", 1)).recent).toHaveLength(1);

    expect(await chainActivity(db, "arbitrum", 5)).toEqual({ moved: 0, recent: [] });
  });
});

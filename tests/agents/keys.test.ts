import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentLabel,
  authenticateAgent,
  bearerKey,
  hashAgentKey,
  newAgentKey,
  peekAgentLink,
  redeemAgentLink,
  revokeAgentKeys,
  startAgentLink,
  takeRateLimit,
} from "@/lib/agents/keys";
import type { Db } from "@/lib/db/client";
import { agentKeys } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import { createTestDb } from "../helpers/db";

const NOW = new Date("2026-10-09T12:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

let db: Db;
let userId: string;

beforeEach(async () => {
  db = await createTestDb();
  userId = (await createUser(db, { phone: "+15550000010", handle: "alex" }, NOW)).id;
});

async function mint(label = "agent"): Promise<string> {
  const { token, code } = await startAgentLink(db, userId, label, NOW);
  const r = await redeemAgentLink(db, token, code, NOW);
  if (!r.ok) throw new Error(r.reason);
  return r.key;
}

describe("agent key format and hashing", () => {
  it("mints prefixed 256-bit keys and hashes them with SHA-256", async () => {
    const key = newAgentKey();
    expect(key).toMatch(/^dial_ak_[A-Za-z0-9_-]{43}$/);
    expect(newAgentKey()).not.toBe(key);
    expect(await hashAgentKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hashAgentKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores only the hash", async () => {
    const key = await mint();
    const rows = await db.select().from(agentKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyHash).toBe(await hashAgentKey(key));
    expect(JSON.stringify(rows)).not.toContain(key);
  });

  it("parses bearer headers strictly", () => {
    const key = newAgentKey();
    expect(bearerKey(`Bearer ${key}`)).toBe(key);
    expect(bearerKey(`bearer ${key}`)).toBe(key);
    expect(bearerKey(key)).toBeNull();
    expect(bearerKey(null)).toBeNull();
    expect(bearerKey("Bearer sk_live_abc")).toBeNull();
    expect(bearerKey(`Bearer ${key} extra`)).toBeNull();
  });

  it("cleans labels", () => {
    expect(agentLabel(undefined)).toBe("agent");
    expect(agentLabel("  my   Claude <script> ")).toBe("my Claude script");
    expect(agentLabel("x".repeat(80))).toHaveLength(40);
    expect(agentLabel("!!!")).toBe("agent");
  });
});

describe("authentication", () => {
  it("accepts a live key, stamps last use, and rejects unknown keys", async () => {
    const key = await mint("claude");
    const agent = await authenticateAgent(db, `Bearer ${key}`, later(5_000));
    expect(agent?.user.handle).toBe("alex");
    expect(agent?.key.label).toBe("claude");
    const [row] = await db.select().from(agentKeys).where(eq(agentKeys.id, agent?.key.id ?? ""));
    expect(row?.lastUsedAt).toEqual(later(5_000));
    expect(await authenticateAgent(db, `Bearer ${newAgentKey()}`, NOW)).toBeNull();
    expect(await authenticateAgent(db, null, NOW)).toBeNull();
  });

  it("rejects every key after revoke", async () => {
    const a = await mint();
    const b = await mint();
    expect(await revokeAgentKeys(db, userId, NOW)).toBe(2);
    expect(await authenticateAgent(db, `Bearer ${a}`, NOW)).toBeNull();
    expect(await authenticateAgent(db, `Bearer ${b}`, NOW)).toBeNull();
    expect(await revokeAgentKeys(db, userId, NOW)).toBe(0);
  });
});

describe("issuance links", () => {
  it("can be peeked without being used, then redeemed once with the right code", async () => {
    const { token, code } = await startAgentLink(db, userId, "claude", NOW);
    expect(await peekAgentLink(db, token, NOW)).toEqual({ userId, label: "claude" });
    expect(await peekAgentLink(db, token, NOW)).not.toBeNull();
    const r = await redeemAgentLink(db, token, code, NOW);
    expect(r.ok).toBe(true);
    expect(await peekAgentLink(db, token, NOW)).toBeNull();
    expect(await redeemAgentLink(db, token, code, NOW)).toEqual({ ok: false, reason: "closed" });
  });

  it("burns attempts on wrong codes and closes after five", async () => {
    const { token, code } = await startAgentLink(db, userId, "agent", NOW);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(await redeemAgentLink(db, token, wrong, NOW)).toEqual({ ok: false, reason: "bad_code" });
    expect(await redeemAgentLink(db, token, code, NOW)).toEqual({ ok: false, reason: "closed" });
    expect(await peekAgentLink(db, token, NOW)).toBeNull();
  });

  it("holds the five-try limit against parallel guesses", async () => {
    const { token, code } = await startAgentLink(db, userId, "agent", NOW);
    const wrong = Array.from({ length: 12 }, (_, n) => String((Number(code) + n + 1) % 1_000_000).padStart(6, "0"));
    const results = await Promise.all(wrong.map((c) => redeemAgentLink(db, token, c, NOW)));
    expect(results.filter((r) => !r.ok && r.reason === "bad_code")).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === "closed")).toHaveLength(7);
    expect(await redeemAgentLink(db, token, code, NOW)).toEqual({ ok: false, reason: "closed" });
  });

  it("lets the right code through on the fifth try", async () => {
    const { token, code } = await startAgentLink(db, userId, "agent", NOW);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await redeemAgentLink(db, token, wrong, NOW);
    expect((await redeemAgentLink(db, token, code, NOW)).ok).toBe(true);
  });

  it("expires after 15 minutes", async () => {
    const { token, code } = await startAgentLink(db, userId, "agent", NOW);
    expect(await peekAgentLink(db, token, later(15 * 60_000))).toBeNull();
    expect(await redeemAgentLink(db, token, code, later(15 * 60_000))).toEqual({ ok: false, reason: "closed" });
  });

  it("is closed by revoke", async () => {
    const { token, code } = await startAgentLink(db, userId, "agent", NOW);
    await revokeAgentKeys(db, userId, NOW);
    expect(await redeemAgentLink(db, token, code, NOW)).toEqual({ ok: false, reason: "closed" });
  });

  it("rejects unknown tokens", async () => {
    expect(await peekAgentLink(db, "nope", NOW)).toBeNull();
    expect(await redeemAgentLink(db, "nope", "123456", NOW)).toEqual({ ok: false, reason: "closed" });
  });
});

describe("rate limits", () => {
  it("counts per fixed window and resets in the next one", async () => {
    await mint();
    const [row] = await db.select().from(agentKeys);
    const keyId = row?.id ?? "";
    const rl = { bucket: "t", limit: 3, windowMs: 60_000 };
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push(await takeRateLimit(db, keyId, rl, NOW));
    expect(results).toEqual([true, true, true, false]);
    expect(await takeRateLimit(db, keyId, { ...rl, bucket: "other" }, NOW)).toBe(true);
    expect(await takeRateLimit(db, keyId, rl, later(60_000))).toBe(true);
  });
});

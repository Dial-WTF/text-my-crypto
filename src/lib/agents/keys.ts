import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { MAX_CODE_ATTEMPTS, newCode } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import { type AgentKey, agentKeys, agentLinks, agentRate, type User, users } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/hash";
import { newId, randomToken } from "@/lib/ids";

export const AGENT_KEY_PREFIX = "dial_ak_";
export const AGENT_LINK_TTL_MS = 15 * 60_000;
export const DEFAULT_AGENT_LABEL = "agent";

const KEY_RE = /^dial_ak_[A-Za-z0-9_-]{43}$/;

/** A new agent key: prefix plus 32 random bytes, base64url. Never stored; only its hash is. */
export function newAgentKey(): string {
  return `${AGENT_KEY_PREFIX}${randomToken(32)}`;
}

export function hashAgentKey(key: string): Promise<string> {
  return sha256Hex(key);
}

function hashLinkToken(token: string): Promise<string> {
  return sha256Hex(`dial-agent-link-v1|${token}`);
}

function hashLinkCode(tokenHash: string, code: string): Promise<string> {
  return sha256Hex(`dial-agent-code-v1|${tokenHash}|${code}`);
}

/** Pulls a well-formed agent key out of an `Authorization: Bearer …` header. */
export function bearerKey(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const key = m?.[1];
  return key && KEY_RE.test(key) ? key : null;
}

/** Cleans a label the person typed after "connect agent". */
export function agentLabel(raw: string | undefined): string {
  const label = (raw ?? "")
    .trim()
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, 40)
    .trim();
  return label || DEFAULT_AGENT_LABEL;
}

export type Agent = { key: AgentKey; user: User };

/** Looks up a live key by its hash and stamps it as used. Revoked or unknown keys get null. */
export async function authenticateAgent(db: Db, header: string | null, now: Date): Promise<Agent | null> {
  const key = bearerKey(header);
  if (!key) return null;
  const [row] = await db
    .select({ key: agentKeys, user: users })
    .from(agentKeys)
    .innerJoin(users, eq(users.id, agentKeys.userId))
    .where(and(eq(agentKeys.keyHash, await hashAgentKey(key)), isNull(agentKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  await db.update(agentKeys).set({ lastUsedAt: now }).where(eq(agentKeys.id, row.key.id));
  return { key: { ...row.key, lastUsedAt: now }, user: row.user };
}

/** Starts issuance: a one-time link token and a code, both to be texted to the account's phone. */
export async function startAgentLink(
  db: Db,
  userId: string,
  label: string,
  now: Date,
): Promise<{ token: string; code: string }> {
  const token = randomToken(24);
  const code = newCode();
  const tokenHash = await hashLinkToken(token);
  await db.insert(agentLinks).values({
    tokenHash,
    userId,
    label,
    codeHash: await hashLinkCode(tokenHash, code),
    expiresAt: new Date(now.getTime() + AGENT_LINK_TTL_MS),
  });
  return { token, code };
}

export type OpenLink = { userId: string; label: string };

/** Reads an unused, unexpired link without consuming it (safe for page loads and link previews). */
export async function peekAgentLink(db: Db, token: string, now: Date): Promise<OpenLink | null> {
  const [row] = await db
    .select({ userId: agentLinks.userId, label: agentLinks.label })
    .from(agentLinks)
    .where(
      and(
        eq(agentLinks.tokenHash, await hashLinkToken(token)),
        isNull(agentLinks.usedAt),
        gt(agentLinks.expiresAt, now),
        lt(agentLinks.codeAttempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type Redeemed =
  | { ok: true; key: string; agent: AgentKey }
  | { ok: false; reason: "closed" | "bad_code" };

/** Checks the texted code, burns the link and mints a key. The plain key is returned exactly once. */
export async function redeemAgentLink(db: Db, token: string, code: string, now: Date): Promise<Redeemed> {
  const tokenHash = await hashLinkToken(token);
  const [link] = await db.select().from(agentLinks).where(eq(agentLinks.tokenHash, tokenHash)).limit(1);
  if (!link || link.usedAt || link.expiresAt <= now || link.codeAttempts >= MAX_CODE_ATTEMPTS) {
    return { ok: false, reason: "closed" };
  }
  if (link.codeHash !== (await hashLinkCode(tokenHash, code.trim()))) {
    await db
      .update(agentLinks)
      .set({ codeAttempts: sql`${agentLinks.codeAttempts} + 1` })
      .where(eq(agentLinks.tokenHash, tokenHash));
    return { ok: false, reason: "bad_code" };
  }
  const used = await db
    .update(agentLinks)
    .set({ usedAt: now })
    .where(and(eq(agentLinks.tokenHash, tokenHash), isNull(agentLinks.usedAt)))
    .returning({ tokenHash: agentLinks.tokenHash });
  if (used.length === 0) return { ok: false, reason: "closed" };

  const key = newAgentKey();
  const [agent] = await db
    .insert(agentKeys)
    .values({ id: newId("ak"), userId: link.userId, keyHash: await hashAgentKey(key), label: link.label, createdAt: now })
    .returning();
  if (!agent) throw new Error("agent key insert returned no row");
  return { ok: true, key, agent };
}

/** Revokes every live key for the account and closes any unused links. Returns how many keys were revoked. */
export async function revokeAgentKeys(db: Db, userId: string, now: Date): Promise<number> {
  const revoked = await db
    .update(agentKeys)
    .set({ revokedAt: now })
    .where(and(eq(agentKeys.userId, userId), isNull(agentKeys.revokedAt)))
    .returning({ id: agentKeys.id });
  await db
    .update(agentLinks)
    .set({ usedAt: now })
    .where(and(eq(agentLinks.userId, userId), isNull(agentLinks.usedAt)));
  return revoked.length;
}

/** The account's live agent keys, newest first. Labels and timestamps only; keys are never stored. */
export async function listAgentKeys(db: Db, userId: string): Promise<AgentKey[]> {
  return db
    .select()
    .from(agentKeys)
    .where(and(eq(agentKeys.userId, userId), isNull(agentKeys.revokedAt)))
    .orderBy(desc(agentKeys.createdAt));
}

/** Turns off one agent key. Only its owner can; returns false if it wasn't theirs or was already off. */
export async function revokeAgentKey(db: Db, userId: string, keyId: string, now: Date): Promise<boolean> {
  const revoked = await db
    .update(agentKeys)
    .set({ revokedAt: now })
    .where(and(eq(agentKeys.id, keyId), eq(agentKeys.userId, userId), isNull(agentKeys.revokedAt)))
    .returning({ id: agentKeys.id });
  return revoked.length > 0;
}

export type RateLimit = { bucket: string; limit: number; windowMs: number };

/** Every tool call, and the subset that creates payments (each one texts a person). */
export const RATE_LIMITS = {
  call: { bucket: "call", limit: 60, windowMs: 60_000 },
  money: { bucket: "money", limit: 20, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimit>;

/**
 * Counts one hit in a fixed window (a single upsert, so concurrent calls can't both slip under).
 * Returns false once the window is over its limit.
 */
export async function takeRateLimit(db: Db, keyId: string, rl: RateLimit, now: Date): Promise<boolean> {
  const windowStart = Math.floor(now.getTime() / rl.windowMs) * rl.windowMs;
  const [row] = await db
    .insert(agentRate)
    .values({ keyId, bucket: rl.bucket, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [agentRate.keyId, agentRate.bucket],
      set: {
        count: sql`CASE WHEN ${agentRate.windowStart} = excluded.window_start THEN ${agentRate.count} + 1 ELSE 1 END`,
        windowStart: sql`excluded.window_start`,
      },
    })
    .returning({ count: agentRate.count });
  return (row?.count ?? 0) <= rl.limit;
}

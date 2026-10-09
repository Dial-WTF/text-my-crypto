import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { MAX_CODE_ATTEMPTS, newCode } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import { loginLinks, type User, users, webSessions } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/hash";
import { randomToken } from "@/lib/ids";

export const LOGIN_LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const SESSION_COOKIE = "dial_session";

const hashLinkToken = (token: string) => sha256Hex(`dial-login-link-v1|${token}`);
const hashLinkCode = (tokenHash: string, code: string) => sha256Hex(`dial-login-code-v1|${tokenHash}|${code}`);
const hashSession = (token: string) => sha256Hex(`dial-session-v1|${token}`);

/** "wallet": a one-time link and a code, both texted to the account's phone. Neither works alone. */
export async function startLoginLink(db: Db, userId: string, now: Date): Promise<{ token: string; code: string }> {
  const token = randomToken(24);
  const code = newCode();
  const tokenHash = await hashLinkToken(token);
  await db.insert(loginLinks).values({
    tokenHash,
    userId,
    codeHash: await hashLinkCode(tokenHash, code),
    expiresAt: new Date(now.getTime() + LOGIN_LINK_TTL_MS),
  });
  return { token, code };
}

/** True while the link can still be redeemed. Safe for page loads and link previews: it consumes nothing. */
export async function loginLinkOpen(db: Db, token: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ userId: loginLinks.userId })
    .from(loginLinks)
    .where(
      and(
        eq(loginLinks.tokenHash, await hashLinkToken(token)),
        isNull(loginLinks.usedAt),
        gt(loginLinks.expiresAt, now),
        lt(loginLinks.codeAttempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export type LoginRedeemed = { ok: true; userId: string } | { ok: false; reason: "closed" | "bad_code" };

/** Checks the texted code and burns the link. Five wrong codes close it. */
export async function redeemLoginLink(db: Db, token: string, code: string, now: Date): Promise<LoginRedeemed> {
  const tokenHash = await hashLinkToken(token);
  const [link] = await db.select().from(loginLinks).where(eq(loginLinks.tokenHash, tokenHash)).limit(1);
  if (!link || link.usedAt || link.expiresAt <= now || link.codeAttempts >= MAX_CODE_ATTEMPTS) {
    return { ok: false, reason: "closed" };
  }
  if (link.codeHash !== (await hashLinkCode(tokenHash, code.replace(/[\s-]/g, "")))) {
    await db
      .update(loginLinks)
      .set({ codeAttempts: sql`${loginLinks.codeAttempts} + 1` })
      .where(eq(loginLinks.tokenHash, tokenHash));
    return { ok: false, reason: "bad_code" };
  }
  const used = await db
    .update(loginLinks)
    .set({ usedAt: now })
    .where(and(eq(loginLinks.tokenHash, tokenHash), isNull(loginLinks.usedAt)))
    .returning({ userId: loginLinks.userId });
  return used[0] ? { ok: true, userId: used[0].userId } : { ok: false, reason: "closed" };
}

/** Starts a session and returns the cookie value. Only its hash is stored. */
export async function createSession(db: Db, userId: string, via: "text" | "passkey", now: Date): Promise<string> {
  const token = randomToken(32);
  await db.insert(webSessions).values({
    tokenHash: await hashSession(token),
    userId,
    via,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  return token;
}

/** The signed-in person for a cookie value, or null if it's missing, expired or signed out. */
export async function sessionUser(db: Db, token: string | undefined, now: Date): Promise<User | null> {
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(webSessions)
    .innerJoin(users, eq(users.id, webSessions.userId))
    .where(
      and(eq(webSessions.tokenHash, await hashSession(token)), isNull(webSessions.revokedAt), gt(webSessions.expiresAt, now)),
    )
    .limit(1);
  return row?.user ?? null;
}

export async function endSession(db: Db, token: string, now: Date): Promise<void> {
  await db.update(webSessions).set({ revokedAt: now }).where(eq(webSessions.tokenHash, await hashSession(token)));
}

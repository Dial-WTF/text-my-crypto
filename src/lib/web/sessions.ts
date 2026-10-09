import { and, eq, gt, isNull, lt, type SQL, sql } from "drizzle-orm";
import { MAX_CODE_ATTEMPTS, newCode } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import { loginLinks, type User, users, webSessions } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/hash";
import { randomToken } from "@/lib/ids";

const LOGIN_LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const SESSION_COOKIE = "dial_session";

const hashLinkToken = (token: string) => sha256Hex(`dial-login-link-v1|${token}`);
const hashLinkCode = (tokenHash: string, code: string) => sha256Hex(`dial-login-code-v1|${tokenHash}|${code}`);
const hashSession = (token: string) => sha256Hex(`dial-session-v1|${token}`);

/**
 * "wallet": a code texted to the account's phone, entered on its permanent /@handle/wallet page. It works
 * once, for 15 minutes, and closes the account's earlier unused codes so only the newest one works.
 *
 * Each code is a login_links row with its own random token. Links texted before the permanent page
 * (/wallet/in/<token>) still redeem by that token; new texts carry only the code.
 */
export async function issueWalletCode(db: Db, userId: string, now: Date): Promise<{ token: string; code: string }> {
  const token = randomToken(24);
  const code = newCode();
  const tokenHash = await hashLinkToken(token);
  const expiresAt = new Date(now.getTime() + LOGIN_LINK_TTL_MS);
  const [row] = await db
    .insert(loginLinks)
    .values({ tokenHash, userId, codeHash: await hashLinkCode(tokenHash, code), expiresAt })
    .returning({ seq: sql<number>`rowid` });
  // Close every open code inserted before this one. SQLite gives each insert a rowid above every row already
  // there, so two WALLET texts handled at once still leave exactly one open code: the later insert.
  await db
    .update(loginLinks)
    .set({ usedAt: now })
    .where(and(eq(loginLinks.userId, userId), isNull(loginLinks.usedAt), sql`rowid < ${row?.seq ?? 0}`));
  return { token, code };
}

const openLink = (now: Date) =>
  and(isNull(loginLinks.usedAt), gt(loginLinks.expiresAt, now), lt(loginLinks.codeAttempts, MAX_CODE_ATTEMPTS));

/** True while a texted /wallet/in/<token> link can still be redeemed. Safe for page loads and link previews. */
export async function loginLinkOpen(db: Db, token: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ userId: loginLinks.userId })
    .from(loginLinks)
    .where(and(eq(loginLinks.tokenHash, await hashLinkToken(token)), openLink(now)))
    .limit(1);
  return Boolean(row);
}

export type LoginRedeemed = { ok: true; userId: string } | { ok: false; reason: "closed" | "bad_code" };

/**
 * Checks a code against the open codes `which` picks and burns the one it matches. Five tries close a code.
 * The try is counted (one conditional UPDATE) before the code is compared, so parallel guesses can't get
 * past the limit.
 */
async function redeem(db: Db, which: SQL, code: string, now: Date): Promise<LoginRedeemed> {
  const open = await db
    .update(loginLinks)
    .set({ codeAttempts: sql`${loginLinks.codeAttempts} + 1` })
    .where(and(which, openLink(now)))
    .returning({ tokenHash: loginLinks.tokenHash, codeHash: loginLinks.codeHash });
  if (!open.length) return { ok: false, reason: "closed" };
  const typed = code.replace(/[\s-]/g, "");
  let match: string | null = null;
  for (const link of open) if (link.codeHash === (await hashLinkCode(link.tokenHash, typed))) match = link.tokenHash;
  if (!match) return { ok: false, reason: "bad_code" };
  const used = await db
    .update(loginLinks)
    .set({ usedAt: now })
    .where(and(eq(loginLinks.tokenHash, match), isNull(loginLinks.usedAt)))
    .returning({ userId: loginLinks.userId });
  return used[0] ? { ok: true, userId: used[0].userId } : { ok: false, reason: "closed" };
}

/** The /@handle/wallet form: checks the account's newest texted code. */
export function redeemWalletCode(db: Db, userId: string, code: string, now: Date): Promise<LoginRedeemed> {
  return redeem(db, eq(loginLinks.userId, userId), code, now);
}

/** A /wallet/in/<token> link texted before the permanent page, with the code from the same text. */
export async function redeemLoginLink(db: Db, token: string, code: string, now: Date): Promise<LoginRedeemed> {
  return redeem(db, eq(loginLinks.tokenHash, await hashLinkToken(token)), code, now);
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

/**
 * Signs the account out everywhere: ends every live web session and closes any unused wallet code.
 * For STOP and "revoke agents". Returns how many sessions were ended.
 */
export async function endSessionsForUser(db: Db, userId: string, now: Date): Promise<number> {
  const ended = await db
    .update(webSessions)
    .set({ revokedAt: now })
    .where(and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt)))
    .returning({ tokenHash: webSessions.tokenHash });
  await db
    .update(loginLinks)
    .set({ usedAt: now })
    .where(and(eq(loginLinks.userId, userId), isNull(loginLinks.usedAt)));
  return ended.length;
}

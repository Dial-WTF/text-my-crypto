import { and, eq, gt, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm";
import { MAX_CODE_ATTEMPTS, newCode } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import { signupTokens, type User, users } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/hash";
import { newId, randomToken } from "@/lib/ids";
import { normalizePhone } from "@/lib/phone";

const SIGNUP_TTL_MS = 15 * 60_000;

export async function findUserByPhone(db: Db, phone: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  return u ?? null;
}

export async function findUserByHandle(db: Db, handle: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.handle, handle)).limit(1);
  return u ?? null;
}

export async function getUserById(db: Db, id: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return u ?? null;
}

export async function resolveRecipient(db: Db, raw: string): Promise<User | null> {
  const phone = normalizePhone(raw);
  if (phone) return findUserByPhone(db, phone);
  return findUserByHandle(db, raw.trim().replace(/^@/, "").toLowerCase());
}

export async function createUser(
  db: Db,
  input: { phone: string; handle: string; name?: string | null },
  now = new Date(),
): Promise<User> {
  const [u] = await db
    .insert(users)
    .values({ id: newId("usr"), ...input, claimedAt: now })
    .returning();
  if (!u) throw new Error("createUser returned no row");
  return u;
}

export async function createUnclaimedUser(db: Db, phone: string): Promise<User> {
  const [u] = await db.insert(users).values({ id: newId("usr"), phone }).returning();
  if (!u) throw new Error("createUnclaimedUser returned no row");
  return u;
}

export async function claimUser(
  db: Db,
  userId: string,
  handle: string,
  now: Date,
  name: string | null = null,
): Promise<User | null> {
  const [u] = await db
    .update(users)
    .set({ handle, name, claimedAt: now })
    .where(and(eq(users.id, userId), isNull(users.claimedAt)))
    .returning();
  return u ?? null;
}

export function isClaimed(u: User): boolean {
  return u.claimedAt !== null && u.handle !== null;
}

function maskedPhone(phone: string): string {
  return `${phone.slice(0, -4).replace(/\d/g, "•")}${phone.slice(-4)}`;
}

/** Short name for messages: the display name, else the handle, else a masked number. */
export function displayName(u: Pick<User, "handle" | "phone"> & { name?: string | null }): string {
  return u.name ?? u.handle ?? maskedPhone(u.phone);
}

/** Unambiguous name for confirmations: "@jpmeyer (J. P. Meyer)". */
export function describe(u: Pick<User, "handle" | "phone"> & { name?: string | null }): string {
  if (u.handle && u.name && u.name.toLowerCase() !== u.handle) return `@${u.handle} (${u.name})`;
  if (u.handle) return `@${u.handle}`;
  return maskedPhone(u.phone);
}

/** First free handle: base, base2, base3… kept within the 20-character limit. */
export async function uniqueHandle(db: Db, base: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? "" : String(n);
    const candidate = `${base.slice(0, 20 - suffix.length)}${suffix}`;
    if (!(await findUserByHandle(db, candidate))) return candidate;
  }
  throw new Error("No free handle");
}

/** The directory: claimed users whose handle starts with, or name contains, the query. */
export async function searchDirectory(db: Db, query: string, limit = 5): Promise<User[]> {
  const q = query.trim().replace(/^@/, "").toLowerCase().replace(/[%_]/g, "");
  if (q.length < 2) return [];
  return db
    .select()
    .from(users)
    .where(
      and(
        isNotNull(users.claimedAt),
        or(like(users.handle, `${q}%`), like(sql`lower(${users.name})`, `%${q}%`)),
      ),
    )
    .limit(limit);
}

/** Sets the display name, and the handle too when one is given (see isPickedHandle). */
export async function renameUser(db: Db, userId: string, name: string, handle?: string): Promise<User | null> {
  const [u] = await db
    .update(users)
    .set(handle ? { name, handle } : { name })
    .where(eq(users.id, userId))
    .returning();
  return u ?? null;
}

/** A handle Dial picked at signup ("dial" and four random characters), which the person's chosen name may replace. */
export function isPickedHandle(handle: string | null): boolean {
  return handle !== null && /^dial[a-z2-7]{4}\d*$/.test(handle);
}

const hashSignupCode = (token: string, code: string) => sha256Hex(`dial-signup-code-v1|${token}|${code}`);

/** "upgrade": a one-time passkey link and a code, both texted to the phone. Neither works alone, like the wallet and agent links. */
export async function createSignupToken(db: Db, phone: string, now: Date): Promise<{ token: string; code: string }> {
  const token = randomToken(18);
  const code = newCode();
  await db
    .insert(signupTokens)
    .values({ token, phone, codeHash: await hashSignupCode(token, code), expiresAt: new Date(now.getTime() + SIGNUP_TTL_MS) });
  return { token, code };
}

/** The phone a passkey link belongs to, while it can still be used. Safe for page loads and link previews: it consumes nothing. */
export async function peekSignupToken(db: Db, token: string, now: Date): Promise<string | null> {
  const [row] = await db
    .select({ phone: signupTokens.phone })
    .from(signupTokens)
    .where(
      and(
        eq(signupTokens.token, token),
        isNull(signupTokens.usedAt),
        gt(signupTokens.expiresAt, now),
        lt(signupTokens.codeAttempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .limit(1);
  return row?.phone ?? null;
}

/**
 * Checks the code texted with a passkey link. Five wrong tries close the link. The try is counted (one
 * conditional UPDATE) before the code is compared, so parallel guesses can't get past the limit; a right
 * code gives it back, so someone whose device cancelled the passkey can try again.
 */
export async function checkSignupCode(db: Db, token: string, code: string, now: Date): Promise<boolean> {
  const open = and(
    eq(signupTokens.token, token),
    isNull(signupTokens.usedAt),
    gt(signupTokens.expiresAt, now),
    isNotNull(signupTokens.codeHash),
  );
  const [row] = await db
    .update(signupTokens)
    .set({ codeAttempts: sql`${signupTokens.codeAttempts} + 1` })
    .where(and(open, lt(signupTokens.codeAttempts, MAX_CODE_ATTEMPTS)))
    .returning({ codeHash: signupTokens.codeHash });
  if (!row?.codeHash || row.codeHash !== (await hashSignupCode(token, code.replace(/[\s-]/g, "")))) return false;
  await db
    .update(signupTokens)
    .set({ codeAttempts: sql`${signupTokens.codeAttempts} - 1` })
    .where(eq(signupTokens.token, token));
  return true;
}

export async function consumeSignupToken(db: Db, token: string, now: Date): Promise<string | null> {
  const [row] = await db
    .update(signupTokens)
    .set({ usedAt: now })
    .where(and(eq(signupTokens.token, token), isNull(signupTokens.usedAt), gt(signupTokens.expiresAt, now)))
    .returning({ phone: signupTokens.phone });
  return row?.phone ?? null;
}

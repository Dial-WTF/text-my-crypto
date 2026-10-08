import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { signupTokens, type User, users } from "@/lib/db/schema";
import { newId, randomToken } from "@/lib/ids";
import { normalizePhone } from "@/lib/phone";

export const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
export const SIGNUP_TTL_MS = 15 * 60_000;

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

export async function createUser(db: Db, input: { phone: string; handle: string }): Promise<User> {
  const [u] = await db
    .insert(users)
    .values({ id: newId("usr"), ...input })
    .returning();
  if (!u) throw new Error("createUser returned no row");
  return u;
}

export async function createSignupToken(db: Db, phone: string, now: Date): Promise<string> {
  const token = randomToken(18);
  await db.insert(signupTokens).values({ token, phone, expiresAt: new Date(now.getTime() + SIGNUP_TTL_MS) });
  return token;
}

export async function peekSignupToken(db: Db, token: string, now: Date): Promise<string | null> {
  const [row] = await db
    .select({ phone: signupTokens.phone })
    .from(signupTokens)
    .where(and(eq(signupTokens.token, token), isNull(signupTokens.usedAt), gt(signupTokens.expiresAt, now)))
    .limit(1);
  return row?.phone ?? null;
}

export async function consumeSignupToken(db: Db, token: string, now: Date): Promise<string | null> {
  const [row] = await db
    .update(signupTokens)
    .set({ usedAt: now })
    .where(and(eq(signupTokens.token, token), isNull(signupTokens.usedAt), gt(signupTokens.expiresAt, now)))
    .returning({ phone: signupTokens.phone });
  return row?.phone ?? null;
}

import { cookies } from "next/headers";
import type { User } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { SESSION_COOKIE, SESSION_TTL_MS, sessionUser } from "./sessions";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_TTL_MS / 1000,
} as const;

/** The person signed in to the wallet page on this request, if any. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return sessionUser(getDb(), token, new Date());
}

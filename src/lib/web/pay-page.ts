import { botDeps } from "@/lib/deps";
import { findUserByHandle, isClaimed } from "@/lib/identity";
import { cleanAsk, type PayProfile, payProfile } from "@/lib/views/pay";

/**
 * The handle in a /@handle route param, lowercased and without the @, or null if it can't be one.
 * Next has already decoded the param once; a stray `%` left in it (from /@%25E0) is not a handle.
 */
export function handleFromParam(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const handle = decoded.replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,32}$/.test(handle) ? handle : null;
}

/** The pay profile behind /@handle and /@handle.json, or null for unknown or unclaimed handles. */
export async function loadPayProfile(
  rawHandle: string,
  query: { amount?: string | null; note?: string | null },
): Promise<PayProfile | null> {
  const handle = handleFromParam(rawHandle);
  if (!handle) return null;
  const deps = botDeps();
  const user = await findUserByHandle(deps.db, handle);
  if (!user || !isClaimed(user)) return null;
  return payProfile(deps, user, cleanAsk(deps, query));
}

import { cache } from "react";
import { botDeps } from "@/lib/deps";
import type { User } from "@/lib/db/schema";
import { findUserByHandle, isClaimed } from "@/lib/identity";
import { cleanAsk, type PayAsk, type PayProfile, payProfile } from "@/lib/views/pay";

type Query = { amount?: string | null; note?: string | null };

/** The claimed user behind a handle. Cached per request: metadata, the page and the card all ask. */
const payee = cache(async (rawHandle: string): Promise<User | null> => {
  const handle = handleFromParam(rawHandle);
  if (!handle) return null;
  const user = await findUserByHandle(botDeps().db, handle);
  return user && isClaimed(user) && user.handle ? user : null;
});

/** Who is being paid and what they asked for: enough for titles and share cards. Reads only; opens no wallets. */
export type PayHeader = PayAsk & { handle: string; name: string };

export async function loadPayHeader(rawHandle: string, query: Query): Promise<PayHeader | null> {
  const user = await payee(rawHandle);
  if (!user?.handle) return null;
  return { handle: user.handle, name: user.name ?? `@${user.handle}`, ...cleanAsk(botDeps(), query) };
}

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
export async function loadPayProfile(rawHandle: string, query: Query): Promise<PayProfile | null> {
  const user = await payee(rawHandle);
  if (!user) return null;
  const deps = botDeps();
  return payProfile(deps, user, cleanAsk(deps, query));
}

/** "?amount=5&note=pizza", or "" when nothing was asked. */
export function askQuery(ask: PayAsk): string {
  const q = new URLSearchParams({ ...(ask.amountUsd ? { amount: ask.amountUsd } : {}), ...(ask.note ? { note: ask.note } : {}) });
  return q.size ? `?${q}` : "";
}

/** The words a share preview uses, from one place for the page title, OG tags and the card. */
export function payWords(h: PayHeader): { title: string; description: string } {
  const who = h.name === `@${h.handle}` ? `@${h.handle}` : `${h.name} (@${h.handle})`;
  const ask = h.amountUsd ? ` $${h.amountUsd}${h.note ? ` for ${h.note}` : ""}` : "";
  return {
    title: `Pay ${who}${ask}`,
    description: h.amountUsd
      ? `${h.name} is asking for $${h.amountUsd} USDC${h.note ? ` for ${h.note}` : ""}. Tap to pay by text from any phone, or scan with any crypto wallet.`
      : `Send ${h.name} crypto by text from any phone, or from any wallet app. USDC on Solana and Tempo. Powered by Dial.Work.`,
  };
}

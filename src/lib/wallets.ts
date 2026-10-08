import { and, eq, isNull } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { type Wallet, wallets } from "@/lib/db/schema";
import { open, seal } from "@/lib/secretbox";

export async function addWallet(
  db: Db,
  input: { userId: string; chain: Chain; address: string; secret: Uint8Array<ArrayBuffer>; keyB64: string },
): Promise<void> {
  await db.insert(wallets).values({
    userId: input.userId,
    chain: input.chain,
    address: input.address,
    secretEnc: await seal(input.secret, input.keyB64),
  });
}

export async function getWallet(db: Db, userId: string, chain: Chain): Promise<Wallet | null> {
  const [w] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.chain, chain)))
    .limit(1);
  return w ?? null;
}

export function unsealWallet(w: Wallet, keyB64: string): Promise<Uint8Array<ArrayBuffer>> {
  return open(w.secretEnc, keyB64);
}

/** Takes this wallet's one test-funds drip. False when it was already taken (or is being taken right now). */
export async function claimDrip(db: Db, userId: string, chain: Chain, now: Date): Promise<boolean> {
  const rows = await db
    .update(wallets)
    .set({ drippedAt: now })
    .where(and(eq(wallets.userId, userId), eq(wallets.chain, chain), isNull(wallets.drippedAt)))
    .returning({ userId: wallets.userId });
  return rows.length > 0;
}

/** Gives the drip back after the transfer failed, so the next attempt retries it. */
export async function releaseDrip(db: Db, userId: string, chain: Chain): Promise<void> {
  await db
    .update(wallets)
    .set({ drippedAt: null })
    .where(and(eq(wallets.userId, userId), eq(wallets.chain, chain)));
}

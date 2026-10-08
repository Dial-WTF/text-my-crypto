import { and, eq } from "drizzle-orm";
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

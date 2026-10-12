import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { intents, wallets } from "@/lib/db/schema";
import { errorText, type SettlementAdapter } from "@/lib/settlement/types";

/**
 * What an attacker could take on Solana right now, in USDC base units, read from the chain and the
 * ledger. A null means that part couldn't be read just now; it is never guessed.
 */
export type Exposure = {
  /** The USDC in each server-held user wallet on Solana; null when any of them couldn't be read. */
  balances: bigint[] | null;
  /** Money waiting in the escrow program for people who haven't joined yet, before expiry. */
  escrows: { count: number; amount: bigint };
  /** The operator's treasury USDC, which funds signups. */
  treasury: bigint | null;
};

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Every user wallet together. */
export function usersTotal(e: Exposure): bigint | null {
  return e.balances ? sum(e.balances) : null;
}

/** Every user wallet, each counted up to `cap`: what an attacker gets in a day when each person's daily cap holds. */
export function usersCapped(e: Exposure, cap: bigint): bigint | null {
  return e.balances ? sum(e.balances.map((b) => min(b, cap))) : null;
}

/** The biggest single wallet, up to `cap`: one person's worst day. */
export function largestCapped(e: Exposure, cap: bigint): bigint | null {
  return e.balances ? e.balances.reduce((m, b) => (min(b, cap) > m ? min(b, cap) : m), 0n) : null;
}

/** Users, live escrows and the treasury together; null when any part couldn't be read. */
export function everything(e: Exposure): bigint | null {
  const users = usersTotal(e);
  return users === null || e.treasury === null ? null : users + e.escrows.amount + e.treasury;
}

async function balanceOrNull(adapter: SettlementAdapter, address: Promise<string> | string): Promise<bigint | null> {
  try {
    return await adapter.getBalance(await address);
  } catch (e) {
    console.error("self-audit balance read failed", errorText(e));
    return null;
  }
}

/** Reads every Solana user wallet's balance, the live escrows and the treasury. */
export async function loadExposure(db: Db, solana: SettlementAdapter, now: Date): Promise<Exposure> {
  const userWallets = await db.select({ address: wallets.address }).from(wallets).where(eq(wallets.chain, "solana"));
  const [escrowRow] = await db
    .select({ count: sql<number>`count(*)`, amount: sql<string | null>`sum(${intents.amount})` })
    .from(intents)
    .where(and(eq(intents.chain, "solana"), eq(intents.status, "escrowed"), gt(intents.escrowExpiresAt, now)));
  const [balances, treasury] = await Promise.all([
    Promise.all(userWallets.map((w) => balanceOrNull(solana, w.address))),
    balanceOrNull(solana, solana.treasuryAddress()),
  ]);
  return {
    balances: balances.every((b): b is bigint => b !== null) ? balances : null,
    escrows: { count: Number(escrowRow?.count ?? 0), amount: BigInt(escrowRow?.amount ?? 0) },
    treasury,
  };
}

import { and, count, desc, inArray, isNotNull, sql } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { type Intent, intents, users } from "@/lib/db/schema";
import { STOCK_TOKEN_ADDRESSES, stockForToken } from "@/lib/stocks";

const MOVED: Intent["status"][] = ["settled", "escrowed", "refunded"];

export type PublicStats = { payments: number; movedUsd: bigint; people: number };

export async function publicStats(db: Db): Promise<PublicStats> {
  const [money] = await db
    // A stock token payment counts as a payment but adds no dollars: its amount is shares, and testnet has no price.
    .select({
      payments: count(),
      moved: sql<number | null>`sum(case when ${inArray(intents.token, [...STOCK_TOKEN_ADDRESSES])} then 0 else ${intents.amount} end)`,
    })
    .from(intents)
    .where(and(inArray(intents.status, MOVED), inArray(intents.kind, ["send", "request", "invoice"])));
  const [people] = await db.select({ n: count() }).from(users).where(isNotNull(users.claimedAt));
  return { payments: money?.payments ?? 0, movedUsd: BigInt(money?.moved ?? 0), people: people?.n ?? 0 };
}

/**
 * How many payments have moved on each chain (settled, escrowed or refunded; withdrawals count, since money
 * moved). A chain with none here is never called "live" on the site.
 */
export async function movedByChain(db: Db): Promise<Partial<Record<Chain, number>>> {
  const rows = await db
    .select({ chain: intents.chain, n: count() })
    .from(intents)
    .where(inArray(intents.status, MOVED))
    .groupBy(intents.chain);
  return Object.fromEntries(rows.filter((r) => r.n > 0).map((r) => [r.chain, r.n]));
}

export type FeedItem = {
  id: string;
  from: string;
  to: string;
  amount: bigint;
  /** The stock token's ticker when the payment moved one; null for dollars. */
  stock: string | null;
  chain: Chain;
  status: Intent["status"];
  txHash: string | null;
  explorerUrl: string | null;
  at: Date;
};

export async function recentPayments(db: Db, limit: number): Promise<FeedItem[]> {
  const rows = await db
    .select()
    .from(intents)
    .where(and(inArray(intents.status, MOVED), inArray(intents.kind, ["send", "request", "invoice"])))
    .orderBy(desc(intents.createdAt))
    .limit(limit);
  const ids = [...new Set(rows.flatMap((r) => [r.senderId, r.recipientId]))];
  const people = ids.length ? await db.select().from(users).where(inArray(users.id, ids)) : [];
  // Public lists show handles, never the names people typed to get paid (and never numbers).
  const who = (id: string) => {
    const handle = people.find((p) => p.id === id)?.handle;
    return handle ? `@${handle}` : "someone new";
  };
  return rows.map((r) => ({
    id: r.id,
    from: who(r.senderId),
    to: who(r.recipientId),
    amount: r.amount,
    stock: stockForToken(r.chain, r.token)?.symbol ?? null,
    chain: r.chain,
    status: r.status,
    txHash: r.txHash,
    explorerUrl: r.explorerUrl,
    at: r.createdAt,
  }));
}

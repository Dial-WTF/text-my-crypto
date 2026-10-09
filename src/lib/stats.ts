import { and, count, desc, inArray, isNotNull, sql } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { type Intent, intents, users } from "@/lib/db/schema";

const MOVED: Intent["status"][] = ["settled", "escrowed", "refunded"];
/** What the public ledger counts as a payment: withdrawals are people moving their own money out. */
const PAYMENT_KINDS: Intent["kind"][] = ["send", "request", "invoice", "venue"];

export type PublicStats = { payments: number; movedUsd: bigint; people: number };

export async function publicStats(db: Db): Promise<PublicStats> {
  const [money] = await db
    .select({ payments: count(), moved: sql<number | null>`sum(${intents.amount})` })
    .from(intents)
    .where(and(inArray(intents.status, MOVED), inArray(intents.kind, PAYMENT_KINDS)));
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
  kind: Intent["kind"];
  from: string;
  to: string;
  amount: bigint;
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
    .where(and(inArray(intents.status, MOVED), inArray(intents.kind, PAYMENT_KINDS)))
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
    kind: r.kind,
    from: who(r.senderId),
    to: who(r.recipientId),
    amount: r.amount,
    chain: r.chain,
    status: r.status,
    txHash: r.txHash,
    explorerUrl: r.explorerUrl,
    at: r.createdAt,
  }));
}

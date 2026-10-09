import { and, count, desc, inArray, isNotNull, sql } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { type Intent, intents, users } from "@/lib/db/schema";

const MOVED: Intent["status"][] = ["settled", "escrowed", "refunded"];

export type PublicStats = { payments: number; movedUsd: bigint; people: number };

export async function publicStats(db: Db): Promise<PublicStats> {
  const [money] = await db
    .select({ payments: count(), moved: sql<number | null>`sum(case when ${intents.private} then 0 else ${intents.amount} end)` })
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
  /** Null for a private send: the public ledger shows it happened, not how much or between whom. */
  amount: bigint | null;
  chain: Chain;
  status: Intent["status"];
  txHash: string | null;
  explorerUrl: string | null;
  at: Date;
  /** Set on each leg of a split; the legs share one transaction. */
  splitId: string | null;
};

/** A split's legs as one entry: everyone it paid, what each got, and the total. */
export type FeedGroup = FeedItem & { legs: Array<{ to: string; amount: bigint }> | null };

/** Folds the legs of each split into one entry (where its newest leg sits); other payments pass through. */
export function groupSplits(items: FeedItem[]): FeedGroup[] {
  const out: FeedGroup[] = [];
  const bySplit = new Map<string, FeedGroup>();
  for (const item of items) {
    // A private send is never a split leg (splits batch on a chain that can't shield), and its amount is hidden.
    const splitId = item.amount === null ? null : item.splitId;
    const legs = [{ to: item.to, amount: item.amount ?? 0n }];
    const group = splitId ? bySplit.get(splitId) : undefined;
    if (!group) {
      const entry: FeedGroup = { ...item, legs: splitId ? legs : null };
      if (splitId) bySplit.set(splitId, entry);
      out.push(entry);
      continue;
    }
    group.legs?.push(...legs);
    group.amount = (group.amount ?? 0n) + (item.amount ?? 0n);
  }
  // Legs come back newest first; list them in the order they were paid.
  for (const g of out) {
    if (!g.legs) continue;
    g.legs.reverse();
    g.to = g.legs.map((l) => l.to).join(", ");
  }
  return out;
}

export async function recentPayments(db: Db, limit: number): Promise<FeedItem[]> {
  const rows = await db
    .select()
    .from(intents)
    .where(and(inArray(intents.status, MOVED), inArray(intents.kind, ["send", "request", "invoice"])))
    // Legs of a split share a timestamp; insertion order keeps them in the order they were listed.
    .orderBy(desc(intents.createdAt), desc(sql`rowid`))
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
    from: r.private ? "someone" : who(r.senderId),
    to: r.private ? "someone" : who(r.recipientId),
    amount: r.private ? null : r.amount,
    chain: r.chain,
    status: r.status,
    txHash: r.txHash,
    explorerUrl: r.explorerUrl,
    at: r.createdAt,
    splitId: r.splitId,
  }));
}

import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { actionPayments, type Intent, intents, users } from "@/lib/db/schema";

const MOVED: Intent["status"][] = ["settled", "escrowed", "refunded"];

export type PublicStats = { payments: number; movedUsd: bigint; people: number };

export async function publicStats(db: Db): Promise<PublicStats> {
  const [money] = await db
    .select({ payments: count(), moved: sql<number | null>`sum(${intents.amount})` })
    .from(intents)
    .where(and(inArray(intents.status, MOVED), inArray(intents.kind, ["send", "request", "invoice"])));
  // Payments from any Solana wallet through a pay link's Blink count once recorded.
  const [blinks] = await db
    .select({ payments: count(), moved: sql<number | null>`sum(${actionPayments.received})` })
    .from(actionPayments)
    .where(isNotNull(actionPayments.signature));
  const [people] = await db.select({ n: count() }).from(users).where(isNotNull(users.claimedAt));
  return {
    payments: (money?.payments ?? 0) + (blinks?.payments ?? 0),
    movedUsd: BigInt(money?.moved ?? 0) + BigInt(blinks?.moved ?? 0),
    people: people?.n ?? 0,
  };
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
  const blinks = await db
    .select({ chain: actionPayments.chain, n: count() })
    .from(actionPayments)
    .where(isNotNull(actionPayments.signature))
    .groupBy(actionPayments.chain);
  const moved: Partial<Record<Chain, number>> = {};
  for (const r of [...rows, ...blinks]) if (r.n > 0) moved[r.chain] = (moved[r.chain] ?? 0) + r.n;
  return moved;
}

export type FeedItem = {
  id: string;
  from: string;
  to: string;
  amount: bigint;
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
    const legs = [{ to: item.to, amount: item.amount }];
    const group = item.splitId ? bySplit.get(item.splitId) : undefined;
    if (!group) {
      const entry: FeedGroup = { ...item, legs: item.splitId ? legs : null };
      if (item.splitId) bySplit.set(item.splitId, entry);
      out.push(entry);
      continue;
    }
    group.legs?.push(...legs);
    group.amount += item.amount;
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
  const fromIntents = rows.map(
    (r): FeedItem => ({
      id: r.id,
      from: who(r.senderId),
      to: who(r.recipientId),
      amount: r.amount,
      chain: r.chain,
      status: r.status,
      txHash: r.txHash,
      explorerUrl: r.explorerUrl,
      at: r.createdAt,
      splitId: r.splitId,
    }),
  );
  return [...fromIntents, ...(await blinkPayments(db, limit))].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

/** Recorded pay-link Blink payments: from the paying wallet's address (it isn't on Dial) to a handle. */
async function blinkPayments(db: Db, limit: number): Promise<FeedItem[]> {
  const rows = await db
    .select({ p: actionPayments, handle: users.handle })
    .from(actionPayments)
    .innerJoin(users, eq(users.id, actionPayments.recipientId))
    .where(isNotNull(actionPayments.signature))
    .orderBy(desc(actionPayments.paidAt))
    .limit(limit);
  return rows.map(({ p, handle }) => ({
    id: p.id,
    from: `${p.payerAddress.slice(0, 4)}…${p.payerAddress.slice(-4)}`,
    to: handle ? `@${handle}` : "someone new",
    amount: p.received ?? p.amount,
    chain: p.chain,
    status: "settled",
    txHash: p.signature,
    explorerUrl: p.explorerUrl,
    at: p.paidAt ?? p.createdAt,
    splitId: null,
  }));
}

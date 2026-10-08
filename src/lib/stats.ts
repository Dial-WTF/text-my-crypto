import { and, count, desc, inArray, isNotNull, sql } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { type Intent, intents, users } from "@/lib/db/schema";
import { displayName } from "@/lib/identity";

const MOVED: Intent["status"][] = ["settled", "escrowed", "refunded"];

export type PublicStats = { payments: number; movedUsd: bigint; people: number };

export async function publicStats(db: Db): Promise<PublicStats> {
  const [money] = await db
    .select({ payments: count(), moved: sql<number | null>`sum(${intents.amount})` })
    .from(intents)
    .where(and(inArray(intents.status, MOVED), inArray(intents.kind, ["send", "request", "invoice"])));
  const [people] = await db.select({ n: count() }).from(users).where(isNotNull(users.claimedAt));
  return { payments: money?.payments ?? 0, movedUsd: BigInt(money?.moved ?? 0), people: people?.n ?? 0 };
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
  const name = (id: string) => {
    const u = people.find((p) => p.id === id);
    return u ? displayName(u) : "someone";
  };
  return rows.map((r) => ({
    id: r.id,
    from: name(r.senderId),
    to: name(r.recipientId),
    amount: r.amount,
    chain: r.chain,
    status: r.status,
    txHash: r.txHash,
    explorerUrl: r.explorerUrl,
    at: r.createdAt,
  }));
}

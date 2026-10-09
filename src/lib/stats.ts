import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { type Intent, intents, users } from "@/lib/db/schema";

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
  chain: Chain;
  status: Intent["status"];
  txHash: string | null;
  explorerUrl: string | null;
  at: Date;
};

/** The newest payments that moved money, on every chain or only on `chain`. */
export async function recentPayments(db: Db, limit: number, chain?: Chain): Promise<FeedItem[]> {
  const rows = await db
    .select()
    .from(intents)
    .where(
      and(
        inArray(intents.status, MOVED),
        inArray(intents.kind, ["send", "request", "invoice"]),
        chain ? eq(intents.chain, chain) : undefined,
      ),
    )
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
    chain: r.chain,
    status: r.status,
    txHash: r.txHash,
    explorerUrl: r.explorerUrl,
    at: r.createdAt,
  }));
}

export type EscrowItem = {
  id: string;
  status: Intent["status"];
  /** The transaction that funded the vault. */
  funded: { txHash: string; explorerUrl: string } | null;
  /** The claim (status settled) or refund (status refunded) that closed it, once one has. */
  closed: { txHash: string; explorerUrl: string } | null;
  at: Date;
};

/** The newest payments that went through an on-chain escrow program on `chain`. Ids and transactions only. */
export async function recentEscrows(db: Db, chain: Chain, limit: number): Promise<EscrowItem[]> {
  const rows = await db
    .select()
    .from(intents)
    .where(and(inArray(intents.status, MOVED), eq(intents.chain, chain), isNotNull(intents.escrowProgram)))
    .orderBy(desc(intents.createdAt))
    .limit(limit);
  const tx = (hash: string | null, url: string | null) => (hash && url ? { txHash: hash, explorerUrl: url } : null);
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    funded: tx(r.txHash, r.explorerUrl),
    closed: tx(r.releaseTxHash, r.releaseExplorerUrl),
    at: r.createdAt,
  }));
}

export type ChainActivity = {
  /** Everything that moved money on the chain, withdrawals included: the same count that makes it "live". */
  moved: number;
  /** The newest payments on it, by handle only. */
  recent: FeedItem[];
};

/** One chain's slice of the public ledger, for its chain page. */
export async function chainActivity(db: Db, chain: Chain, limit: number): Promise<ChainActivity> {
  const [[row], recent] = await Promise.all([
    db
      .select({ n: count() })
      .from(intents)
      .where(and(inArray(intents.status, MOVED), eq(intents.chain, chain))),
    recentPayments(db, limit, chain),
  ]);
  return { moved: row?.n ?? 0, recent };
}

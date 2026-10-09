import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { actionPayments, type Intent, intents, users } from "@/lib/db/schema";
import { STOCK_TOKEN_ADDRESSES, stockForToken } from "@/lib/stocks";

const MOVED: Intent["status"][] = ["settled", "escrowed", "refunded"];

export type PublicStats = { payments: number; movedUsd: bigint; people: number };

export async function publicStats(db: Db): Promise<PublicStats> {
  const [money] = await db
    // A private send and a stock token payment count as payments but add no dollars: one is hidden, the other
    // is shares, and testnet has no price for them.
    .select({
      payments: count(),
      moved: sql<number | null>`sum(case when ${intents.private} or ${inArray(intents.token, [...STOCK_TOKEN_ADDRESSES])} then 0 else ${intents.amount} end)`,
    })
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
  /** Null for a private send: the public ledger shows it happened, not how much or between whom. */
  amount: bigint | null;
  /** The stock token's ticker when the payment moved one; null for dollars. */
  stock?: string | null;
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

/** The newest payments that moved money (Blink payments included), on every chain or only on `chain`. */
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
      // A private send shows only that it happened, on which chain, and its txid.
      from: r.private ? "someone" : who(r.senderId),
      to: r.private ? "someone" : who(r.recipientId),
      amount: r.private ? null : r.amount,
      stock: stockForToken(r.chain, r.token)?.symbol ?? null,
      chain: r.chain,
      status: r.status,
      txHash: r.txHash,
      explorerUrl: r.explorerUrl,
      at: r.createdAt,
      splitId: r.splitId,
    }),
  );
  return [...fromIntents, ...(await blinkPayments(db, limit, chain))].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

/** Recorded pay-link Blink payments: from the paying wallet's address (it isn't on Dial) to a handle. */
async function blinkPayments(db: Db, limit: number, chain?: Chain): Promise<FeedItem[]> {
  const rows = await db
    .select({ p: actionPayments, handle: users.handle })
    .from(actionPayments)
    .innerJoin(users, eq(users.id, actionPayments.recipientId))
    .where(and(isNotNull(actionPayments.signature), chain ? eq(actionPayments.chain, chain) : undefined))
    .orderBy(desc(actionPayments.paidAt))
    .limit(limit);
  return rows.map(({ p, handle }) => ({
    id: p.id,
    from: `${p.payerAddress.slice(0, 4)}…${p.payerAddress.slice(-4)}`,
    to: handle ? `@${handle}` : "someone new",
    amount: p.received ?? p.amount,
    stock: null,
    chain: p.chain,
    status: "settled",
    txHash: p.signature,
    explorerUrl: p.explorerUrl,
    at: p.paidAt ?? p.createdAt,
    splitId: null,
  }));
}

export type SplitItem = {
  splitId: string;
  /** Who got a share, by handle ("someone new" for a share waiting to be claimed), in the order listed. */
  legs: Array<{ to: string; amount: bigint }>;
  total: bigint;
  /** The one transaction that carried every leg. */
  txHash: string | null;
  explorerUrl: string | null;
  at: Date;
};

/** The newest split that moved money on `chain`, with all its legs; null when there hasn't been one. */
export async function latestSplit(db: Db, chain: Chain): Promise<SplitItem | null> {
  const [newest] = await db
    .select({ splitId: intents.splitId })
    .from(intents)
    .where(and(inArray(intents.status, MOVED), eq(intents.chain, chain), isNotNull(intents.splitId)))
    .orderBy(desc(intents.createdAt), desc(sql`rowid`))
    .limit(1);
  if (!newest?.splitId) return null;
  const rows = await db
    .select()
    .from(intents)
    .where(and(eq(intents.splitId, newest.splitId), inArray(intents.status, MOVED)))
    .orderBy(sql`rowid`);
  const ids = [...new Set(rows.map((r) => r.recipientId))];
  const people = ids.length ? await db.select().from(users).where(inArray(users.id, ids)) : [];
  const who = (id: string) => {
    const handle = people.find((p) => p.id === id)?.handle;
    return handle ? `@${handle}` : "someone new";
  };
  const first = rows[0];
  if (!first) return null;
  return {
    splitId: newest.splitId,
    legs: rows.map((r) => ({ to: who(r.recipientId), amount: r.amount })),
    total: rows.reduce((sum, r) => sum + r.amount, 0n),
    txHash: first.txHash,
    explorerUrl: first.explorerUrl,
    at: first.createdAt,
  };
}

/** The demo handle (DEMO_HANDLE) if someone has claimed it, else null: the pay-link demo never shows anyone else. */
export async function demoHandle(db: Db, handle: string | undefined): Promise<string | null> {
  if (!handle) return null;
  const [row] = await db
    .select({ handle: users.handle })
    .from(users)
    .where(and(eq(users.handle, handle), isNotNull(users.claimedAt)))
    .limit(1);
  return row?.handle ?? null;
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
  // The same count movedByChain gives the live rule, Blink payments included.
  const [moved, recent] = await Promise.all([movedByChain(db), recentPayments(db, limit, chain)]);
  return { moved: moved[chain] ?? 0, recent };
}

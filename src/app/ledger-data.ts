import { getDb } from "@/lib/db/client";
import { type ChainProof, chainProofs, networkName } from "@/lib/ledger";
import { stateLabel, timeAgo } from "@/lib/payment-labels";
import { type PublicStats, publicStats, recentPayments } from "@/lib/stats";
import type { FeedEntry } from "@/ui/patterns/PaymentFeed/PaymentFeed";

export type Ledger = { stats: PublicStats | null; feed: FeedEntry[]; proofs: ChainProof[] };

/** Stats, recent payments and treasury links. A page still renders, with dashes, if any of it is down. */
export async function loadLedger(limit: number): Promise<Ledger> {
  const [ledger, proofs] = await Promise.all([
    (async () => {
      const db = getDb();
      const [stats, rows] = await Promise.all([publicStats(db), recentPayments(db, limit)]);
      const now = new Date();
      const feed = rows.map((r) => ({
        id: r.id,
        from: r.from,
        to: r.to,
        amount: r.amount,
        network: networkName(r.chain),
        // The public ledger lists money that moved, so there is no deadline to apply.
        state: stateLabel(r.status, null, now),
        txHash: r.txHash,
        explorerUrl: r.explorerUrl,
        when: timeAgo(r.at, now),
      }));
      return { stats, feed };
    })().catch((e: unknown) => {
      console.error("ledger unavailable", e);
      return { stats: null, feed: [] };
    }),
    chainProofs().catch((e: unknown) => {
      console.error("chain proofs unavailable", e);
      return [];
    }),
  ]);
  return { ...ledger, proofs };
}

export const PROOF_NOTE =
  "Every payment carries its id on-chain: the memo on Solana and Tempo, the authorization nonce on EVM chains. Match any row to its transaction, or open a treasury to see every drop, fee and escrow.";

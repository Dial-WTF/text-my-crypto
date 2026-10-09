import { getDb } from "@/lib/db/client";
import { type ChainProof, chainProofs, safeNetworkName } from "@/lib/ledger";
import { errorText } from "@/lib/settlement/types";
import { type PublicStats, publicStats, recentPayments } from "@/lib/stats";
import type { FeedEntry } from "@/ui/patterns/PaymentFeed/PaymentFeed";

const STATE_LABEL: Record<string, string> = { settled: "delivered", escrowed: "waiting to be claimed", refunded: "refunded" };

export type Ledger = { stats: PublicStats | null; feed: FeedEntry[]; proofs: ChainProof[] };

/** Runs one part of a public ledger. If it throws, logs the (redacted) error and returns the fallback. */
export async function quietly<T>(label: string, part: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await part();
  } catch (e) {
    console.error(label, errorText(e));
    return fallback;
  }
}

/** Stats, recent payments and treasury links. A page still renders, with dashes, if any of it is down. */
export async function loadLedger(limit: number): Promise<Ledger> {
  const [stats, rows, proofs] = await Promise.all([
    quietly<PublicStats | null>("ledger stats unavailable", () => publicStats(getDb()), null),
    quietly("ledger payments unavailable", () => recentPayments(getDb(), limit), []),
    quietly("chain proofs unavailable", () => chainProofs(), []),
  ]);
  const feed = rows.map((r) => ({
    id: r.id,
    from: r.from,
    to: r.to,
    amount: r.amount,
    network: safeNetworkName(r.chain),
    state: STATE_LABEL[r.status] ?? r.status,
    txHash: r.txHash,
    explorerUrl: r.explorerUrl,
  }));
  return { stats, feed, proofs };
}

export const PROOF_NOTE =
  "Every payment carries its id on-chain: the memo on Solana and Tempo, the authorization nonce on EVM chains. Match any row to its transaction, or open a treasury to see every drop, fee and escrow.";

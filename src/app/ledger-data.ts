import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { type ChainProof, chainProofs, networkName } from "@/lib/ledger";
import { type PublicStats, publicStats, recentPayments } from "@/lib/stats";
import type { FeedEntry } from "@/ui/patterns/PaymentFeed/PaymentFeed";

const STATE_LABEL: Record<string, string> = { settled: "delivered", escrowed: "waiting to be claimed", refunded: "refunded" };

export type Ledger = { stats: PublicStats | null; feed: FeedEntry[]; proofs: ChainProof[]; note: string };

/** Stats, recent payments and treasury links. A page still renders, with dashes, if any of it is down. */
export async function loadLedger(limit: number): Promise<Ledger> {
  const [ledger, proofs] = await Promise.all([
    (async () => {
      const db = getDb();
      const [stats, rows] = await Promise.all([publicStats(db), recentPayments(db, limit)]);
      const feed = rows.map((r) => ({
        id: r.id,
        from: r.from,
        to: r.to,
        amount: r.amount,
        network: networkName(r.chain),
        state: STATE_LABEL[r.status] ?? r.status,
        txHash: r.txHash,
        explorerUrl: r.explorerUrl,
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
  return { ...ledger, proofs, note: proofNote(proofs) };
}

const PROOF_NOTE =
  "Every payment carries its id on-chain: the memo on Solana and Tempo, the authorization nonce on EVM chains. Match any row to its transaction, or open a treasury to see every drop, fee and escrow.";

/** The line under the addresses. Mentions the escrow program only where one is switched on. */
function proofNote(proofs: ChainProof[]): string {
  if (!proofs.some((p) => p.escrowProgram)) return PROOF_NOTE;
  const days = env().ESCROW_TTL_DAYS;
  return `${PROOF_NOTE} Money for someone not on Dial yet waits in the escrow program: it pays them only once they prove their phone, and after ${days} days anyone can send it back to the sender.`;
}

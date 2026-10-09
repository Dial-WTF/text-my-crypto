import { cache } from "react";
import { type ChainStatus, chainStatuses } from "@/lib/chain-status";
import type { Chain } from "@/lib/chains";
import { getDb } from "@/lib/db/client";
import { env, publicEnv } from "@/lib/env";
import { type ChainProof, chainProofs, safeNetworkName } from "@/lib/ledger";
import { stateLabel, timeAgo } from "@/lib/payment-labels";
import { errorText } from "@/lib/settlement/types";
import { groupSplits, movedByChain, type PublicStats, publicStats, recentPayments } from "@/lib/stats";
import type { FeedEntry } from "@/ui/patterns/PaymentFeed/PaymentFeed";

export type Ledger = { stats: PublicStats | null; feed: FeedEntry[]; proofs: ChainProof[]; note: string };

/**
 * Each chain's status with the ledger behind it: "live" only where a payment has moved. Once per request,
 * since the landing page, its colophon and a card may all ask. If D1 can't be read, nothing is live.
 */
export const loadChainStatuses = cache(async (): Promise<ChainStatus[]> => {
  const { CHAINS, NETWORK } = publicEnv();
  const moved = await quietly("chain activity unavailable", async () => movedByChain(getDb()), {});
  return chainStatuses(CHAINS, NETWORK, new Set(Object.keys(moved) as Chain[]));
});

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
  const now = new Date();
  const feed = groupSplits(rows).map((r) => ({
    id: r.id,
    from: r.from,
    to: r.to,
    amount: r.amount,
    network: safeNetworkName(r.chain),
    // The public ledger lists money that moved, so there is no deadline to apply.
    state: stateLabel(r.status, null, now),
    txHash: r.txHash,
    explorerUrl: r.explorerUrl,
    when: timeAgo(r.at, now),
    ...(r.legs ? { legs: r.legs } : {}),
  }));
  return { stats, feed, proofs, note: proofNote(proofs) };
}

const PROOF_NOTE =
  "Every payment carries its id on-chain: the memo on Solana and Tempo, the authorization nonce on EVM chains. Match any row to its transaction, or open a treasury to see every drop, fee and escrow.";

/** The line under the addresses. Mentions the escrow program only where one is switched on. */
function proofNote(proofs: ChainProof[]): string {
  if (!proofs.some((p) => p.escrowProgram)) return PROOF_NOTE;
  const days = env().ESCROW_TTL_DAYS;
  return `${PROOF_NOTE} Money for someone not on Dial yet waits in the escrow program: it pays them only once they prove their phone, and after ${days} days anyone can send it back to the sender. On devnet Dial still holds the key that can upgrade the program; on mainnet that key goes to a multisig or the program is frozen.`;
}

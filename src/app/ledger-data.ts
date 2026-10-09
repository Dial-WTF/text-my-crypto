import { cache } from "react";
import { type ChainStatus, chainStatuses } from "@/lib/chain-status";
import type { Chain } from "@/lib/chains";
import { getDb } from "@/lib/db/client";
import { env, publicEnv } from "@/lib/env";
import { type ChainProof, chainProofs, safeNetworkName } from "@/lib/ledger";
import { stateLabel, timeAgo } from "@/lib/payment-labels";
import { activeChains, getAdapters } from "@/lib/settlement";
import { money } from "@/lib/settlement/amounts";
import { type FeatureId, featuresOf } from "@/lib/settlement/capabilities";
import { errorText, type SettlementAdapter } from "@/lib/settlement/types";
import {
  type ChainActivity,
  chainActivity,
  type FeedItem,
  groupSplits,
  movedByChain,
  type PublicStats,
  publicStats,
  recentPayments,
} from "@/lib/stats";
import { memoizer } from "@/lib/web/memo";
import type { FeedEntry } from "@/ui/patterns/PaymentFeed/PaymentFeed";
import type { LatestPayment } from "@/ui/patterns/WatchSettle/WatchSettle";
import { ATTACHED_FEATURES, liveExplorer } from "./chain-content";

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
  return { stats, feed: feedEntries(rows, new Date()), proofs, note: proofNote(proofs) };
}

/** Feed rows as people read them, a split's legs folded into one entry. */
function feedEntries(rows: FeedItem[], now: Date): FeedEntry[] {
  return groupSplits(rows).map((r) => ({
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
}

export type ChainLedger = {
  /** Null when the ledger can't be read: the page says so instead of showing a zero. */
  activity: (Omit<ChainActivity, "recent"> & { feed: FeedEntry[] }) | null;
  /**
   * The treasury (and escrow program) as the running adapter reports it; null while the chain is off.
   * `treasuryUrl` is null where the registry's explorer doesn't serve pages.
   */
  proof: (Omit<ChainProof, "treasuryUrl"> & { treasuryUrl: string | null }) | null;
};

const latestMemo = memoizer<LatestPayment | null>({ ttlMs: 10_000, maxKeys: 32 });

/** The newest payment on `chain`, read at most every 10 seconds per isolate. Null when there is none; throws when D1 can't be read. */
export async function loadLatestPayment(chain: Chain): Promise<LatestPayment | null> {
  return latestMemo(chain, async () => {
    const [row] = (await chainActivity(getDb(), chain, 1)).recent;
    if (!row) return null;
    const [entry] = feedEntries([row], new Date());
    if (!entry) return null;
    // Plain strings only: this goes out as JSON, so no bigints (a split's legs carry some).
    const { id, from, to, network, state, txHash } = entry;
    const explorerUrl = liveExplorer(entry.explorerUrl);
    return { id, from, to, network, state, txHash, explorerUrl, amount: entry.amount === null ? "shielded" : money(entry.amount, chain, publicEnv().NETWORK), when: entry.when ?? "" };
  });
}

/**
 * The chain-native modules a chain carries: the running adapter's own list when it can be built, else
 * what the code attaches (ATTACHED_FEATURES), so a page without secrets still says what is built.
 */
export function loadChainFeatures(chain: Chain): { features: FeatureId[]; adapter: SettlementAdapter | null } {
  try {
    const adapter = getAdapters()[chain];
    if (adapter) return { features: featuresOf(adapter), adapter };
  } catch (e) {
    console.error("chain features unavailable", chain, errorText(e));
  }
  return { features: ATTACHED_FEATURES[chain], adapter: null };
}

/** One chain's page of the ledger, read per request: what moved there, the latest payments, its treasury. */
export async function loadChainLedger(chain: Chain, limit: number): Promise<ChainLedger> {
  const [activity, proofs] = await Promise.all([
    quietly<ChainActivity | null>("chain activity unavailable", () => chainActivity(getDb(), chain, limit), null),
    quietly("chain proofs unavailable", () => chainProofs(getAdapters(), activeChains().filter((a) => a.chain === chain)), []),
  ]);
  const proof = proofs[0] ?? null;
  // A chain page never offers a link its explorer can't serve as proof.
  const feed = activity ? feedEntries(activity.recent, new Date()).map((e) => ({ ...e, explorerUrl: liveExplorer(e.explorerUrl) })) : [];
  return {
    activity: activity ? { moved: activity.moved, feed } : null,
    proof: proof && { ...proof, treasuryUrl: liveExplorer(proof.treasuryUrl) },
  };
}

const PROOF_NOTE =
  "Every payment carries its id on-chain: the memo on Solana and Tempo, the authorization nonce on EVM chains. Match any row to its transaction, or open a treasury to see every drop, fee and escrow.";

/** The line under the addresses. Mentions the escrow program only where one is switched on. */
function proofNote(proofs: ChainProof[]): string {
  if (!proofs.some((p) => p.escrowProgram)) return PROOF_NOTE;
  const days = env().ESCROW_TTL_DAYS;
  return `${PROOF_NOTE} Money for someone not on Dial yet waits in the escrow program: it pays them only once they prove their phone, and after ${days} days anyone can send it back to the sender. On devnet Dial still holds the key that can upgrade the program; on mainnet that key goes to a multisig or the program is frozen.`;
}

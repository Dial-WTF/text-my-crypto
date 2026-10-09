import { getDb } from "@/lib/db/client";
import { chainProofs, runningNetwork, safeNetworkName } from "@/lib/ledger";
import { type PublicStats, publicStats, recentPayments } from "@/lib/stats";
import { formatShares } from "@/lib/stocks";
import { quietly } from "../ledger-data";

export const dynamic = "force-dynamic";

const usd = (baseUnits: bigint) => (Number(baseUnits) / 1_000_000).toString();

/**
 * The public ledger for agents and judges: settled payments with their transactions, and the
 * treasuries behind them. Each part is loaded on its own; one that is down comes back empty (stats
 * and network as null) instead of failing the whole response.
 */
export async function GET(): Promise<Response> {
  const [stats, rows, proofs] = await Promise.all([
    quietly<PublicStats | null>("ledger stats unavailable", () => publicStats(getDb()), null),
    quietly("ledger payments unavailable", () => recentPayments(getDb(), 100), []),
    quietly("chain proofs unavailable", () => chainProofs(), []),
  ]);
  return Response.json(
    {
      network: runningNetwork(),
      stats: stats && { payments: stats.payments, movedUsd: usd(stats.movedUsd), people: stats.people },
      treasuries: proofs.map(({ chain, network, treasury, treasuryUrl }) => ({ chain, network, address: treasury, explorer: treasuryUrl })),
      escrowPrograms: proofs.flatMap(({ chain, network, escrowProgram }) =>
        escrowProgram ? [{ chain, network, address: escrowProgram.address, explorer: escrowProgram.url }] : [],
      ),
      payments: rows.map((r) => ({
        id: r.id,
        from: r.from,
        to: r.to,
        ...(r.amount === null
          ? { amountUsd: null }
          : r.stock
            ? { amountUsd: null, shares: formatShares(r.amount), asset: r.stock }
            : { amountUsd: usd(r.amount) }),
        shielded: r.amount === null,
        chain: r.chain,
        network: safeNetworkName(r.chain),
        status: r.status,
        tx: r.txHash,
        explorer: r.explorerUrl,
        at: r.at.toISOString(),
        split: r.splitId,
      })),
    },
    { headers: { "cache-control": "public, max-age=30" } },
  );
}

import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { chainProofs, networkName } from "@/lib/ledger";
import { publicStats, recentPayments } from "@/lib/stats";

export const dynamic = "force-dynamic";

const usd = (baseUnits: bigint) => (Number(baseUnits) / 1_000_000).toString();

/** The public ledger for agents and judges: settled payments with their transactions, and the treasuries behind them. */
export async function GET(): Promise<Response> {
  const db = getDb();
  const [stats, rows, proofs] = await Promise.all([publicStats(db), recentPayments(db, 100), chainProofs()]);
  return Response.json(
    {
      network: env().NETWORK,
      stats: { payments: stats.payments, movedUsd: usd(stats.movedUsd), people: stats.people },
      treasuries: proofs.map(({ chain, network, treasury, treasuryUrl }) => ({ chain, network, address: treasury, explorer: treasuryUrl })),
      escrowPrograms: proofs.flatMap(({ chain, network, escrowProgram }) =>
        escrowProgram ? [{ chain, network, address: escrowProgram.address, explorer: escrowProgram.url }] : [],
      ),
      payments: rows.map((r) => ({
        id: r.id,
        from: r.from,
        to: r.to,
        amountUsd: usd(r.amount),
        chain: r.chain,
        network: networkName(r.chain),
        status: r.status,
        tx: r.txHash,
        explorer: r.explorerUrl,
        at: r.at.toISOString(),
      })),
    },
    { headers: { "cache-control": "public, max-age=30" } },
  );
}

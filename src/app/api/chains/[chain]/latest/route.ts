import { CHAINS, type Chain } from "@/lib/chains";
import { errorText } from "@/lib/settlement/types";
import { loadLatestPayment } from "../../../../ledger-data";

export const dynamic = "force-dynamic";

/**
 * The newest payment on one chain, for "Watch it settle" on its chain page. Public and read-only: handles
 * and transaction links only, cached for 15 seconds at the edge and read from D1 at most every 10 seconds.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/chains/[chain]/latest">): Promise<Response> {
  const { chain } = await ctx.params;
  if (!(CHAINS as readonly string[]).includes(chain)) return Response.json({ error: "unknown chain" }, { status: 404 });
  try {
    const payment = await loadLatestPayment(chain as Chain);
    return Response.json({ payment }, { headers: { "cache-control": "public, max-age=15, s-maxage=15" } });
  } catch (e) {
    console.error("latest payment unavailable", chain, errorText(e));
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

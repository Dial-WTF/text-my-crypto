import { authenticateAgent, RATE_LIMITS, takeRateLimit } from "@/lib/agents/keys";
import { botDeps } from "@/lib/deps";
import { walletJson, walletView } from "@/lib/views/wallet";

export const dynamic = "force-dynamic";

/** The owner's wallet as JSON, for their agent. Read-only: bearer dial_ak_ key. */
export async function GET(req: Request): Promise<Response> {
  const deps = botDeps();
  const now = deps.now();
  const agent = await authenticateAgent(deps.db, req.headers.get("authorization"), now);
  if (!agent) return Response.json({ error: "unauthorized", message: "Send Authorization: Bearer dial_ak_…" }, { status: 401 });
  if (!(await takeRateLimit(deps.db, agent.key.id, RATE_LIMITS.call, now))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  return Response.json(walletJson(await walletView(deps, agent.user)), { headers: { "cache-control": "no-store" } });
}

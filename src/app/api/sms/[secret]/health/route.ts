import { getDb } from "@/lib/db/client";
import { botDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import { isUsdAmount, usdToBaseUnits } from "@/lib/money";
import { dependencyChecks } from "@/lib/health";
import { safeEqual } from "@/lib/runtime";
import { activeChains, getAdapters } from "@/lib/settlement";
import { errorText } from "@/lib/settlement/types";

export const dynamic = "force-dynamic";

/** Read-only dependency check behind the webhook secret. Never sends a text and never moves money. */
export async function GET(req: Request, ctx: RouteContext<"/api/sms/[secret]/health">): Promise<Response> {
  const { secret } = await ctx.params;
  if (!safeEqual(secret, env().SMS_WEBHOOK_SECRET)) return new Response("Not found", { status: 404 });
  const e = env();
  const checks = await dependencyChecks({
    db: getDb(),
    payphone: { baseUrl: e.PAYPHONE_BASE_URL, apiKey: e.PAYPHONE_API_KEY },
    adapters: getAdapters(),
  });
  // Which RPC each chain resolved to. Host only: keyed URLs carry their key in the path or query.
  const rpcs = Object.fromEntries(
    activeChains(e).map(({ chain, entry, rpc }) => [chain, `${entry.id} via ${rpc.source} (${new URL(rpc.url).host})`]),
  );
  // ?llm=1 also runs one sample text through the operator's model (opt-in: the watchdog runs every minute).
  if (new URL(req.url).searchParams.get("llm") === "1") checks.llm = await llmCheck();
  const ok = Object.values(checks).every((c) => c.ok);
  return Response.json({ ok, network: e.NETWORK, rpcs, checks }, { status: ok ? 200 : 503 });
}

const LLM_SAMPLE = "can u pay alex five bucks for lunch";

async function llmCheck(): Promise<{ ok: boolean; ms: number; detail?: string }> {
  const start = Date.now();
  try {
    const r = await botDeps().llm(LLM_SAMPLE, []);
    const ok = r.intent === "send" && !!r.amountUsd && isUsdAmount(r.amountUsd) && usdToBaseUnits(r.amountUsd) === 5_000_000n;
    return { ok, ms: Date.now() - start, detail: `${r.intent} ${r.counterparty ?? "-"} ${r.amountUsd ?? "-"} "${r.note ?? ""}"` };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, detail: errorText(err).slice(0, 200) };
  }
}

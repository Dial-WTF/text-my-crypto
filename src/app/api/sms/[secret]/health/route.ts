import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/runtime";
import { getAdapters } from "@/lib/settlement";

export const dynamic = "force-dynamic";

type Check = { ok: boolean; ms: number; detail?: string };

async function timed(fn: () => Promise<string | undefined>): Promise<Check> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Date.now() - start, ...(detail ? { detail } : {}) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, ms: Date.now() - start, detail: message.replace(/\d{7,}/g, "…").slice(0, 300) };
  }
}

/** Read-only dependency check behind the webhook secret. Never sends a text and never moves money. */
export async function GET(_req: Request, ctx: RouteContext<"/api/sms/[secret]/health">): Promise<Response> {
  const { secret } = await ctx.params;
  if (!safeEqual(secret, env().SMS_WEBHOOK_SECRET)) return new Response("Not found", { status: 404 });
  const e = env();
  const adapters = getAdapters();
  const probe = "11111111111111111111111111111111";
  const checks: Record<string, Check> = {
    d1: await timed(async () => {
      await getDb().run(sql`select 1`);
      return undefined;
    }),
    payphoneAuth: await timed(async () => {
      const res = await fetch(`${e.PAYPHONE_BASE_URL}/api/v1/numbers/mine`, {
        headers: { authorization: `Bearer ${e.PAYPHONE_API_KEY}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return undefined;
    }),
  };
  for (const [chain, adapter] of Object.entries(adapters)) {
    if (!adapter) continue;
    const address = chain === "solana" ? probe : "0x000000000000000000000000000000000000dEaD";
    checks[`${chain}Balance`] = await timed(async () => `${await adapter.getBalance(address)}`);
  }
  const ok = Object.values(checks).every((c) => c.ok);
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}

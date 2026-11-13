import { recordActionPayments } from "@/lib/actions/record";
import { reconcileEscrows, reconcileTransfers, resumeUnknownSettlements } from "@/lib/bot/settle";
import { getDb } from "@/lib/db/client";
import { botDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/runtime";
import { getAdapters } from "@/lib/settlement";
import { errorText } from "@/lib/settlement/types";
import { runWatchdog } from "@/lib/watchdog/run";

export const dynamic = "force-dynamic";

/**
 * One watchdog pass, run every minute by the cron trigger in worker.ts. Behind the webhook secret.
 * Alerts are logged, never texted: automated texts from the operator line got its previous number
 * blocked by the carrier. Also settles escrow fundings that
 * didn't confirm in time, from what the chain says, and records payments made through pay-link Blinks.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/sms/[secret]/watchdog">): Promise<Response> {
  const { secret } = await ctx.params;
  if (!safeEqual(secret, env().SMS_WEBHOOK_SECRET)) return new Response("Not found", { status: 404 });
  const e = env();
  const report = await runWatchdog({
    db: getDb(),
    now: () => new Date(),
    payphone: { baseUrl: e.PAYPHONE_BASE_URL, apiKey: e.PAYPHONE_API_KEY, line: e.DIAL_OPERATOR_NUMBER },
    // Payphone's inbox is the real line's; only the deployment that line points at can reconcile it.
    reconcile: e.SMS_MODE === "payphone",
    adapters: getAdapters(),
    alert: null,
  });
  const escrows = await reconcileEscrows(botDeps()).catch((err: unknown) => {
    console.error(JSON.stringify({ evt: "reconcile_escrows", error: errorText(err) }));
    return null;
  });
  // Transfers that went out without an answer: settled or failed from what the chain says about them.
  const transfers = await reconcileTransfers(botDeps()).catch((err: unknown) => {
    console.error(JSON.stringify({ evt: "reconcile_transfers", error: errorText(err) }));
    return null;
  });
  const actionPayments = await recordActionPayments(botDeps()).catch((err: unknown) => {
    console.error(JSON.stringify({ evt: "record_action_payments", error: errorText(err) }));
    return null;
  });
  // Payments whose send went out without an answer (Zcash's wallet service timed out, say) get asked
  // again with the same arguments until they settle or definitely fail. Never blocks the report.
  const resumed = await resumeUnknownSettlements(botDeps()).catch((err: unknown) => {
    console.error(JSON.stringify({ evt: "resume_settlements", error: errorText(err) }));
    return [];
  });
  return Response.json({ ...report, escrows, transfers, actionPayments, ...(resumed.length ? { resumed: resumed.length } : {}) });
}

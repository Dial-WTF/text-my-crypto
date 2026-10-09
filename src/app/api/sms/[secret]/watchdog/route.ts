import { recordActionPayments } from "@/lib/actions/record";
import { reconcileEscrows } from "@/lib/bot/settle";
import { getDb } from "@/lib/db/client";
import { botDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import { normalizePhone } from "@/lib/phone";
import { safeEqual } from "@/lib/runtime";
import { getAdapters } from "@/lib/settlement";
import { logSender, payphoneSender } from "@/lib/sms/payphone";
import { errorText } from "@/lib/settlement/types";
import { runWatchdog } from "@/lib/watchdog/run";

export const dynamic = "force-dynamic";

/**
 * One watchdog pass, run every minute by the cron trigger in worker.ts. Behind the webhook secret.
 * Texts only ALERT_PHONE, at most once per problem per 30 minutes. Also settles escrow fundings that
 * didn't confirm in time, from what the chain says, and records payments made through pay-link Blinks.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/sms/[secret]/watchdog">): Promise<Response> {
  const { secret } = await ctx.params;
  if (!safeEqual(secret, env().SMS_WEBHOOK_SECRET)) return new Response("Not found", { status: 404 });
  const e = env();
  const owner = e.ALERT_PHONE ? normalizePhone(e.ALERT_PHONE) : null;
  if (e.ALERT_PHONE && !owner) console.error(JSON.stringify({ evt: "watchdog", error: "ALERT_PHONE is not a phone number" }));
  const send =
    e.SMS_MODE === "payphone" && e.PAYPHONE_API_KEY
      ? payphoneSender({ baseUrl: e.PAYPHONE_BASE_URL, apiKey: e.PAYPHONE_API_KEY, from: e.DIAL_OPERATOR_NUMBER })
      : logSender;
  const report = await runWatchdog({
    db: getDb(),
    now: () => new Date(),
    payphone: { baseUrl: e.PAYPHONE_BASE_URL, apiKey: e.PAYPHONE_API_KEY, line: e.DIAL_OPERATOR_NUMBER },
    // Payphone's inbox is the real line's; only the deployment that line points at can reconcile it.
    reconcile: e.SMS_MODE === "payphone",
    adapters: getAdapters(),
    alert: owner ? (body) => send(owner, body) : null,
  });
  const escrows = await reconcileEscrows(botDeps()).catch((err: unknown) => {
    console.error(JSON.stringify({ evt: "reconcile_escrows", error: errorText(err) }));
    return null;
  });
  const actionPayments = await recordActionPayments(botDeps()).catch((err: unknown) => {
    console.error(JSON.stringify({ evt: "record_action_payments", error: errorText(err) }));
    return null;
  });
  return Response.json({ ...report, escrows, actionPayments });
}

// Runs in the custom worker entry (worker.ts), outside the Next.js bundle: keep imports tiny.
import { normalizePhone } from "@/lib/phone";
import { payphoneSender } from "@/lib/sms/payphone";

export type ScheduledEnv = {
  APP_URL: string;
  SMS_WEBHOOK_SECRET: string;
  SMS_MODE?: string;
  PAYPHONE_API_KEY?: string;
  PAYPHONE_BASE_URL?: string;
  DIAL_OPERATOR_NUMBER?: string;
  ALERT_PHONE?: string;
};

const QUIET_MS = 30 * 60_000;
let lastBrokenAlert = 0;

/**
 * The cron trigger's job: run the watchdog route in-process. If the app cannot even answer it (a bad
 * deploy, env that fails to parse), text the owner straight from here, throttled per isolate.
 */
export async function scheduledWatchdog(
  fetchApp: (req: Request) => Promise<Response>,
  env: ScheduledEnv,
  opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const url = new URL(`/api/sms/${env.SMS_WEBHOOK_SECRET}/watchdog`, env.APP_URL);
  let problem: string | null = null;
  try {
    const res = await fetchApp(new Request(url, { method: "POST" }));
    if (!res.ok) problem = `watchdog route answered ${res.status}`;
  } catch (e) {
    problem = `watchdog route threw ${e instanceof Error ? e.name : "error"}`;
  }
  if (!problem) return;
  console.error(JSON.stringify({ evt: "watchdog", ok: false, error: problem }));

  const now = (opts.now ?? Date.now)();
  const owner = env.ALERT_PHONE ? normalizePhone(env.ALERT_PHONE) : null;
  if (env.SMS_MODE !== "payphone" || !owner || !env.PAYPHONE_API_KEY || !env.DIAL_OPERATOR_NUMBER) return;
  if (now - lastBrokenAlert < QUIET_MS) return;
  const send = payphoneSender(
    { baseUrl: env.PAYPHONE_BASE_URL ?? "https://payphone.wtf", apiKey: env.PAYPHONE_API_KEY, from: env.DIAL_OPERATOR_NUMBER },
    opts.fetchImpl,
  );
  try {
    await send(owner, `Dial watchdog. PROBLEM: the app is not answering (${problem}). Texts may be failing.`);
    lastBrokenAlert = now;
  } catch {
    console.error(JSON.stringify({ evt: "watchdog", ok: false, error: "fallback alert failed" }));
  }
}

/** Tests only. */
export function resetScheduledForTests(): void {
  lastBrokenAlert = 0;
}

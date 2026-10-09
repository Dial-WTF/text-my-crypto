// Runs in the custom worker entry (worker.ts), outside the Next.js bundle: keep imports tiny.
import { normalizePhone } from "@/lib/phone";
import { payphoneSender } from "@/lib/sms/payphone";
import { mayAlertStateless } from "./slot";

/** The bit of D1's API this file uses, so tests can hand it SQLite. */
export type D1Like = {
  prepare(query: string): { bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null>; run(): Promise<unknown> } };
};

export type ScheduledEnv = {
  APP_URL: string;
  SMS_WEBHOOK_SECRET: string;
  DB?: D1Like;
  SMS_MODE?: string;
  PAYPHONE_API_KEY?: string;
  PAYPHONE_BASE_URL?: string;
  DIAL_OPERATOR_NUMBER?: string;
  ALERT_PHONE?: string;
};

const KEY = "app";
const ALERT_AFTER = 2;
const REALERT_MS = 30 * 60_000;

/**
 * Counts one failing run for the "app" problem in watchdog_problems (the table the watchdog route
 * keeps; the route marks it passing again once it answers) and says whether to alert: from the second
 * failing run in a row, at most once per 30 minutes. Throws when D1 is unreachable.
 */
async function recordFailure(db: D1Like, detail: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `insert into watchdog_problems (key, detail, failures, passes, first_seen_at) values (?1, ?2, 1, 0, ?3)
       on conflict (key) do update set
         detail = excluded.detail,
         passes = 0,
         failures = case when resolved_at is null then failures + 1 else 1 end,
         first_seen_at = case when resolved_at is null then first_seen_at else excluded.first_seen_at end,
         resolved_at = null
       returning failures, last_alerted_at`,
    )
    .bind(KEY, detail, now)
    .first<{ failures: number; last_alerted_at: number | null }>();
  if (!row || row.failures < ALERT_AFTER) return false;
  return row.last_alerted_at === null || now - row.last_alerted_at >= REALERT_MS;
}

/**
 * The cron trigger's job: run the watchdog route in-process. If the app cannot even answer it (a bad
 * deploy, env that fails to parse), text the owner straight from here: after two failing minutes and
 * at most every 30 minutes, tracked in D1; if D1 is unreachable too, on the stateless 30-minute slot.
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

  const now = (opts.now ?? Date.now)();
  let alert: boolean;
  let state = "d1";
  try {
    if (!env.DB) throw new Error("no DB binding");
    alert = await recordFailure(env.DB, problem, now);
  } catch {
    state = "stateless";
    alert = mayAlertStateless(now);
  }
  console.error(JSON.stringify({ evt: "watchdog", ok: false, failing: [KEY], error: problem, state }));
  if (!alert) return;

  const owner = env.ALERT_PHONE ? normalizePhone(env.ALERT_PHONE) : null;
  if (env.SMS_MODE !== "payphone" || !owner || !env.PAYPHONE_API_KEY || !env.DIAL_OPERATOR_NUMBER) return;
  const send = payphoneSender(
    { baseUrl: env.PAYPHONE_BASE_URL ?? "https://payphone.wtf", apiKey: env.PAYPHONE_API_KEY, from: env.DIAL_OPERATOR_NUMBER },
    opts.fetchImpl,
  );
  try {
    await send(owner, `Dial watchdog. PROBLEM: app: not answering (${problem}). Texts may be failing.`);
  } catch {
    console.error(JSON.stringify({ evt: "watchdog", ok: false, error: "fallback alert failed" }));
    return;
  }
  if (state === "d1" && env.DB) {
    await env.DB.prepare("update watchdog_problems set last_alerted_at = ?1 where key = ?2")
      .bind(now, KEY)
      .run()
      .catch(() => {});
  }
}

import type { Db } from "@/lib/db/client";
import { dependencyChecks } from "@/lib/health";
import type { Adapters } from "@/lib/settlement/types";
import { describeError } from "@/lib/sms/trace";
import {
  AGED_LOOKBACK_MS,
  describeMissing,
  describeUnanswered,
  fetchPayphoneInbox,
  findMissing,
  findUnanswered,
  LOOKBACK_MS,
} from "./checks";
import { alertText, type CheckResult, markSent, type Plan, planAlerts } from "./problems";
import { mayAlertStateless } from "./slot";

export type WatchdogDeps = {
  db: Db;
  now: () => Date;
  fetchImpl?: typeof fetch;
  /** No key (staging, in log mode): the Payphone checks are skipped. */
  payphone: { baseUrl: string; apiKey?: string; line: string };
  /** Compare against Payphone's inbox. Only where the line really points at this deployment. */
  reconcile: boolean;
  adapters: Adapters;
  /** Texts the owner. Null when no ALERT_PHONE is set: alerts are only logged. */
  alert: ((body: string) => Promise<void>) | null;
};

export type WatchdogReport = {
  ok: boolean;
  checks: Record<string, { ok: boolean | null; detail: string }>;
  alerted: string[];
  recovered: string[];
  agedOut: string[];
  sent: boolean;
  error?: string;
  ms: number;
};

/** Dependencies flap; wait for a second failing minute before texting about them. */
const DEPENDENCY_ALERT_AFTER = 2;

async function gather(deps: WatchdogDeps, now: Date): Promise<CheckResult[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const results: CheckResult[] = [];
  const health = await dependencyChecks({ db: deps.db, payphone: deps.payphone, adapters: deps.adapters, fetchImpl });
  for (const [key, c] of Object.entries(health)) {
    results.push({ key, ok: c.ok, detail: c.ok ? "ok" : (c.detail ?? "failed"), alertAfter: DEPENDENCY_ALERT_AFTER });
  }

  // The app answered the cron's call to this route; worker.ts records it as failing when it can't.
  results.push({ key: "app", ok: true, detail: "ok" });

  try {
    const rows = await findUnanswered(deps.db, now, AGED_LOOKBACK_MS);
    results.push(windowed("unanswered", rows, (r) => r.createdAt, now, (current) => describeUnanswered(current, now)));
  } catch (e) {
    results.push({ key: "unanswered", ok: null, detail: describeError(e) });
  }

  const apiKey = deps.payphone.apiKey;
  if (deps.reconcile && apiKey) {
    try {
      const inbox = await fetchPayphoneInbox({ ...deps.payphone, apiKey }, fetchImpl);
      results.push({ key: "payphoneInbox", ok: true, detail: "ok" });
      const missing = await findMissing(deps.db, inbox, now, AGED_LOOKBACK_MS);
      results.push(windowed("undelivered", missing, (m) => m.at, now, (current) => describeMissing(current, now)));
    } catch (e) {
      const detail = describeError(e);
      results.push({ key: "payphoneInbox", ok: false, detail, alertAfter: DEPENDENCY_ALERT_AFTER });
      results.push({ key: "undelivered", ok: null, detail: "inbox unavailable" });
    }
  }
  return results;
}

/**
 * Splits a check's bad items at the lookback: recent ones fail it; if only older ones remain, it passes
 * marked agedOut, so its problem closes as "aged out" rather than "Cleared".
 */
function windowed<T>(key: string, items: T[], at: (item: T) => Date, now: Date, describe: (current: T[]) => string): CheckResult {
  const since = now.getTime() - LOOKBACK_MS;
  const current = items.filter((i) => at(i).getTime() >= since);
  if (current.length) return { key, ok: false, detail: describe(current) };
  if (items.length) return { key, ok: true, agedOut: true, detail: `${items.length} aged out of the 1h window unfixed` };
  return { key, ok: true, detail: "none" };
}

/**
 * One watchdog pass: dependency health, unanswered texts and (in production) Payphone reconciliation.
 * Texts the owner about new problems at most every 30 minutes each, and once when they clear.
 * Logs exactly one structured line. Never throws.
 */
export async function runWatchdog(deps: WatchdogDeps): Promise<WatchdogReport> {
  const started = Date.now();
  const now = deps.now();
  const report: WatchdogReport = { ok: true, checks: {}, alerted: [], recovered: [], agedOut: [], sent: false, ms: 0 };
  try {
    const results = await gather(deps, now);
    for (const r of results) report.checks[r.key] = { ok: r.ok, detail: r.detail };
    report.ok = results.every((r) => r.ok !== false);

    let plan: Plan;
    try {
      plan = await planAlerts(deps.db, results, now);
    } catch (e) {
      // No alert state (D1 is the likely culprit). Alert anyway, on the stateless 30-minute slot.
      report.error = `alert state unavailable: ${describeError(e)}`;
      const failing = results.filter((r) => r.ok === false);
      plan = { alert: failing.map((r) => ({ key: r.key, detail: r.detail })), recovered: [], agedOut: [] };
      if (!plan.alert.length || !mayAlertStateless(now.getTime())) plan.alert = [];
    }
    report.alerted = plan.alert.map((a) => a.key);
    report.recovered = plan.recovered;
    report.agedOut = plan.agedOut;

    const text = alertText(plan);
    if (text) {
      if (deps.alert) await deps.alert(text);
      report.sent = deps.alert !== null;
      if (!report.error) await markSent(deps.db, plan, now);
    }
  } catch (e) {
    report.ok = false;
    report.error = describeError(e);
  }
  report.ms = Date.now() - started;
  logRun(report);
  return report;
}

function logRun(r: WatchdogReport): void {
  const failing = Object.entries(r.checks)
    .filter(([, c]) => c.ok === false)
    .map(([k]) => k);
  const line = JSON.stringify({
    evt: "watchdog",
    ok: r.ok,
    failing,
    alerted: r.alerted,
    recovered: r.recovered,
    agedOut: r.agedOut,
    sent: r.sent,
    ms: r.ms,
    ...(r.error ? { error: r.error } : {}),
  });
  if (r.ok && !r.error) console.log(line);
  else console.error(line);
}

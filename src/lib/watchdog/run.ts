import type { Db } from "@/lib/db/client";
import { dependencyChecks } from "@/lib/health";
import type { Adapters } from "@/lib/settlement/types";
import { describeError } from "@/lib/sms/trace";
import { describeMissing, describeUnanswered, fetchPayphoneInbox, findMissing, findUnanswered } from "./checks";
import { alertText, type CheckResult, markSent, type Plan, planAlerts } from "./problems";

export type WatchdogDeps = {
  db: Db;
  now: () => Date;
  fetchImpl?: typeof fetch;
  payphone: { baseUrl: string; apiKey: string; line: string };
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

  try {
    const rows = await findUnanswered(deps.db, now);
    results.push({ key: "unanswered", ok: rows.length === 0, detail: describeUnanswered(rows, now) });
  } catch (e) {
    results.push({ key: "unanswered", ok: null, detail: describeError(e) });
  }

  if (deps.reconcile) {
    try {
      const inbox = await fetchPayphoneInbox(deps.payphone, fetchImpl);
      results.push({ key: "payphoneInbox", ok: true, detail: "ok" });
      const missing = await findMissing(deps.db, inbox, now);
      results.push({ key: "undelivered", ok: missing.length === 0, detail: describeMissing(missing, now) });
    } catch (e) {
      const detail = describeError(e);
      results.push({ key: "payphoneInbox", ok: false, detail, alertAfter: DEPENDENCY_ALERT_AFTER });
      results.push({ key: "undelivered", ok: null, detail: "inbox unavailable" });
    }
  }
  return results;
}

/** When D1 itself is down there is nowhere to keep alert state; this isolate remembers instead. */
let lastStatelessAlert = 0;

/**
 * One watchdog pass: dependency health, unanswered texts and (in production) Payphone reconciliation.
 * Texts the owner about new problems at most every 30 minutes each, and once when they clear.
 * Logs exactly one structured line. Never throws.
 */
export async function runWatchdog(deps: WatchdogDeps): Promise<WatchdogReport> {
  const started = Date.now();
  const now = deps.now();
  const report: WatchdogReport = { ok: true, checks: {}, alerted: [], recovered: [], sent: false, ms: 0 };
  try {
    const results = await gather(deps, now);
    for (const r of results) report.checks[r.key] = { ok: r.ok, detail: r.detail };
    report.ok = results.every((r) => r.ok !== false);

    let plan: Plan;
    try {
      plan = await planAlerts(deps.db, results, now);
    } catch (e) {
      // No alert state (D1 is the likely culprit). Alert anyway, throttled per isolate.
      report.error = `alert state unavailable: ${describeError(e)}`;
      const failing = results.filter((r) => r.ok === false);
      plan = { alert: failing.map((r) => ({ key: r.key, detail: r.detail })), recovered: [] };
      if (now.getTime() - lastStatelessAlert < 30 * 60_000) plan.alert = [];
    }
    report.alerted = plan.alert.map((a) => a.key);
    report.recovered = plan.recovered;

    const text = alertText(plan);
    if (text) {
      if (deps.alert) await deps.alert(text);
      report.sent = deps.alert !== null;
      if (report.error) lastStatelessAlert = now.getTime();
      else await markSent(deps.db, plan, now);
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
    sent: r.sent,
    ms: r.ms,
    ...(r.error ? { error: r.error } : {}),
  });
  if (r.ok && !r.error) console.log(line);
  else console.error(line);
}

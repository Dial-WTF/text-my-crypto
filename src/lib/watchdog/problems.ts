import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { watchdogProblems } from "@/lib/db/schema";

/** At most one alert per check per this window, however long it stays broken or however often it flaps. */
export const REALERT_MS = 30 * 60_000;
/** Passing runs in a row before an open problem counts as resolved. */
export const RESOLVE_AFTER = 2;

/**
 * One check's outcome in a run. `ok: null` means it could not be evaluated this run (say the Payphone
 * inbox did not load): its problem, if any, is left exactly as it was. `alertAfter` is how many failing
 * runs in a row it takes to alert, so a single RPC blip stays quiet. `agedOut` marks a pass that only
 * happened because the bad items left the lookback window, not because anything was fixed.
 */
export type CheckResult = { key: string; ok: boolean | null; detail: string; alertAfter?: number; agedOut?: boolean };

export type Plan = {
  /** Failing checks to alert about now. */
  alert: Array<{ key: string; detail: string }>;
  /** Alerted problems that are fixed. */
  recovered: string[];
  /** Alerted problems whose items aged out of the window unfixed. */
  agedOut: string[];
};

/**
 * Records this run's results and decides what to text. Rows are kept after a problem resolves, so the
 * 30-minute window always counts from the check's last alert: a check that flaps texts at most one
 * PROBLEM (and its all-clear) per window. A problem resolves after two passing runs; it gets an
 * all-clear text only if this incident was alerted, so quiet blips stay quiet.
 * The caller texts the plan, then calls `markSent`, so a text that failed to send is retried next run.
 */
export async function planAlerts(db: Db, results: CheckResult[], now: Date): Promise<Plan> {
  const rows = new Map((await db.select().from(watchdogProblems)).map((p) => [p.key, p]));
  const plan: Plan = { alert: [], recovered: [], agedOut: [] };
  for (const r of results) {
    if (r.ok === null) continue;
    const row = rows.get(r.key);
    const open = row && !row.resolvedAt ? row : null;

    if (r.ok) {
      if (!open) continue;
      const passes = open.passes + 1;
      const alerted = open.lastAlertedAt !== null && open.lastAlertedAt >= open.firstSeenAt;
      if (passes >= RESOLVE_AFTER && alerted) (r.agedOut ? plan.agedOut : plan.recovered).push(r.key);
      const resolveNow = passes >= RESOLVE_AFTER && !alerted;
      await db
        .update(watchdogProblems)
        .set({ passes, failures: 0, ...(resolveNow ? { resolvedAt: now } : {}) })
        .where(eq(watchdogProblems.key, r.key));
      continue;
    }

    const failures = (open?.failures ?? 0) + 1;
    if (open) {
      await db.update(watchdogProblems).set({ failures, passes: 0, detail: r.detail }).where(eq(watchdogProblems.key, r.key));
    } else if (row) {
      await db
        .update(watchdogProblems)
        .set({ failures, passes: 0, detail: r.detail, firstSeenAt: now, resolvedAt: null })
        .where(eq(watchdogProblems.key, r.key));
    } else {
      await db.insert(watchdogProblems).values({ key: r.key, detail: r.detail, failures, firstSeenAt: now });
    }
    const quietFor = row?.lastAlertedAt ? now.getTime() - row.lastAlertedAt.getTime() : Infinity;
    if (failures >= (r.alertAfter ?? 1) && quietFor >= REALERT_MS) plan.alert.push({ key: r.key, detail: r.detail });
  }
  return plan;
}

/** After the plan's text went out: stamp the alerts and resolve what cleared or aged out. */
export async function markSent(db: Db, plan: Plan, now: Date): Promise<void> {
  const alerted = plan.alert.map((a) => a.key);
  if (alerted.length) {
    await db.update(watchdogProblems).set({ lastAlertedAt: now }).where(inArray(watchdogProblems.key, alerted));
  }
  const resolved = [...plan.recovered, ...plan.agedOut];
  if (resolved.length) {
    await db.update(watchdogProblems).set({ resolvedAt: now }).where(inArray(watchdogProblems.key, resolved));
  }
}

/** The one text for a plan, or null when there is nothing to say. Never carries a full phone number. */
export function alertText(plan: Plan): string | null {
  const parts: string[] = [];
  if (plan.alert.length) parts.push(`PROBLEM: ${plan.alert.map((a) => `${a.key}: ${a.detail}`).join("; ")}.`);
  if (plan.recovered.length) parts.push(`Cleared: ${plan.recovered.join(", ")}.`);
  if (plan.agedOut.length) parts.push(`Aged out unfixed (past the 1h window, no longer watched): ${plan.agedOut.join(", ")}.`);
  if (!parts.length) return null;
  return `Dial watchdog. ${parts.join(" ")}`.slice(0, 600);
}

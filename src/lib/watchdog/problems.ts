import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { watchdogProblems } from "@/lib/db/schema";

/** At most one alert per problem per this window, however long it stays broken. */
export const REALERT_MS = 30 * 60_000;

/**
 * One check's outcome in a run. `ok: null` means it could not be evaluated this run (say the Payphone
 * inbox did not load): its problem, if any, is left exactly as it was. `alertAfter` is how many failing
 * runs in a row it takes to alert, so a single RPC blip stays quiet.
 */
export type CheckResult = { key: string; ok: boolean | null; detail: string; alertAfter?: number };

export type Plan = {
  /** Failing checks to alert about now. */
  alert: Array<{ key: string; detail: string }>;
  /** Checks that were alerted about and are fine again. */
  recovered: string[];
};

/**
 * Records this run's results and decides what to text. Failing checks count up; a check alerts once
 * it reaches its threshold and was not alerted in the last 30 minutes. A passing check drops its row;
 * it is reported as recovered only if it had alerted, so quiet blips never send an all-clear.
 * The caller texts the plan, then calls `markSent`, so a text that failed to send is retried next run.
 */
export async function planAlerts(db: Db, results: CheckResult[], now: Date): Promise<Plan> {
  const open = new Map((await db.select().from(watchdogProblems)).map((p) => [p.key, p]));
  const plan: Plan = { alert: [], recovered: [] };
  for (const r of results) {
    const existing = open.get(r.key);
    if (r.ok === null) continue;
    if (r.ok) {
      if (!existing) continue;
      if (existing.lastAlertedAt) plan.recovered.push(r.key);
      else await db.delete(watchdogProblems).where(eq(watchdogProblems.key, r.key));
      continue;
    }
    const failures = (existing?.failures ?? 0) + 1;
    if (existing) {
      await db.update(watchdogProblems).set({ failures, detail: r.detail }).where(eq(watchdogProblems.key, r.key));
    } else {
      await db.insert(watchdogProblems).values({ key: r.key, detail: r.detail, failures, firstSeenAt: now });
    }
    const quietSince = existing?.lastAlertedAt ? now.getTime() - existing.lastAlertedAt.getTime() : Infinity;
    if (failures >= (r.alertAfter ?? 1) && quietSince >= REALERT_MS) plan.alert.push({ key: r.key, detail: r.detail });
  }
  return plan;
}

/** After the plan's text went out: stamp the alerts and close the recovered problems. */
export async function markSent(db: Db, plan: Plan, now: Date): Promise<void> {
  const alerted = plan.alert.map((a) => a.key);
  if (alerted.length) {
    await db.update(watchdogProblems).set({ lastAlertedAt: now }).where(inArray(watchdogProblems.key, alerted));
  }
  if (plan.recovered.length) await db.delete(watchdogProblems).where(inArray(watchdogProblems.key, plan.recovered));
}

/** The one text for a plan, or null when there is nothing to say. Never carries a full phone number. */
export function alertText(plan: Plan): string | null {
  const parts: string[] = [];
  if (plan.alert.length) parts.push(`PROBLEM: ${plan.alert.map((a) => `${a.key}: ${a.detail}`).join("; ")}.`);
  if (plan.recovered.length) parts.push(`Cleared: ${plan.recovered.join(", ")}.`);
  if (!parts.length) return null;
  return `Dial watchdog. ${parts.join(" ")}`.slice(0, 600);
}

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { smsLog, watchdogProblems } from "@/lib/db/schema";
import { type Check, timed } from "@/lib/health";
import { problemLabel, publicRows, roughAge, stateOf, type ServiceState, type StatusRow } from "@/lib/public-status";
import { errorText } from "@/lib/settlement/types";
import { findUnanswered } from "@/lib/watchdog/checks";
import { LAST_RUN_KEY } from "@/lib/watchdog/problems";

/** A text waiting longer than this for its reply makes texting down. */
export const WAITING_DOWN_MS = 5 * 60_000;
/** The watchdog runs every minute: a few minutes' gap is a hiccup, longer means it stopped. */
export const RUN_OK_MS = 3 * 60_000;
export const RUN_SLOW_MS = 10 * 60_000;
/** Incidents shown: the most recent this many, from this far back. */
export const INCIDENT_LIMIT = 5;
export const INCIDENT_WINDOW_MS = 24 * 60 * 60_000;
/** The model takes a second or two on a good day; only well past that is it slow. */
export const LLM_SLOW_MS = 8_000;

export type Incident = { label: string; open: boolean; started: string; resolved: string | null };

/**
 * Everything the public status page shows, already reduced to allowlisted names, ok/slow/down, counts
 * and rounded ages. `incidents` is null when they couldn't be read (so the page doesn't claim none).
 */
export type Board = { rows: StatusRow[]; problems: string[]; incidents: Incident[] | null };

export type BoardDeps = {
  db: Db;
  now: Date;
  /** dependencyChecks, bound to this environment. */
  dependencies: () => Promise<Record<string, Check>>;
  networkName: (chain: Chain) => string;
  /** The language model check (the caller decides how often it really runs), or null with no model configured. */
  llm: () => Promise<Check | null>;
  /** The escrow program sends use, when there is one. */
  escrow: { address: string; href: string; check: () => Promise<Check> } | null;
};

/** When the latest reply to someone who had texted in went out, or null if none has. */
export async function lastAnsweredAt(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ at: smsLog.createdAt })
    .from(smsLog)
    .where(
      and(
        eq(smsLog.direction, "out"),
        sql`exists (select 1 from sms_log i where i.direction = 'in' and i.phone = ${smsLog.phone} and i.rowid < sms_log.rowid)`,
      ),
    )
    .orderBy(sql`sms_log.rowid desc`)
    .limit(1);
  return row?.at ?? null;
}

const accountInfo = z.object({ result: z.object({ value: z.object({ executable: z.boolean() }).nullable() }) });

/** One getAccountInfo call: passes only when the program account exists and is executable. */
export function programCheck(rpcUrl: string, address: string, fetchImpl: typeof fetch = fetch): Promise<Check> {
  return timed(async () => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64" }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = accountInfo.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error("unexpected getAccountInfo answer");
    if (!parsed.data.result.value?.executable) throw new Error("program account missing or not executable");
    return undefined;
  });
}

async function serviceRows(d: BoardDeps): Promise<StatusRow[]> {
  let checks: Record<string, Check>;
  try {
    checks = await d.dependencies();
  } catch (err) {
    console.error("status checks unavailable", errorText(err));
    return [];
  }
  const failed: Check = { ok: false, ms: 0 };
  const [llm, escrow] = await Promise.all([
    d.llm().catch(() => failed),
    d.escrow ? d.escrow.check().catch(() => failed) : null,
  ]);
  const extra: StatusRow[] = [];
  if (llm) extra.push({ kind: "service", name: "Language model (Workers AI)", state: stateOf(llm, LLM_SLOW_MS) });
  if (d.escrow && escrow) {
    const { address, href } = d.escrow;
    extra.push({ kind: "service", name: "Solana escrow program", state: stateOf(escrow), link: { address, href } });
  }
  const rows = publicRows(checks, d.networkName);
  return [...rows.filter((r) => r.kind === "service"), ...extra, ...rows.filter((r) => r.kind === "network")];
}

async function textingRows(db: Db, now: Date): Promise<StatusRow[]> {
  const [answered, waiting] = await Promise.all([
    lastAnsweredAt(db).then(
      (at): StatusRow => ({ kind: "texting", name: "Last text answered", state: null, value: at ? roughAge(now.getTime() - at.getTime()) : "none yet" }),
      (): StatusRow => ({ kind: "texting", name: "Last text answered", state: null, value: "unknown" }),
    ),
    findUnanswered(db, now).then(
      (rows): StatusRow => {
        const oldest = rows[0];
        const state: ServiceState = !oldest ? "ok" : now.getTime() - oldest.createdAt.getTime() > WAITING_DOWN_MS ? "down" : "slow";
        return { kind: "texting", name: "Texts waiting for a reply", state, value: String(rows.length) };
      },
      (): StatusRow => ({ kind: "texting", name: "Texts waiting for a reply", state: null, value: "unknown" }),
    ),
  ]);
  return [answered, waiting];
}

async function watchdogSection(db: Db, now: Date): Promise<Board> {
  let all: Array<typeof watchdogProblems.$inferSelect>;
  try {
    all = await db.select().from(watchdogProblems);
  } catch {
    return {
      rows: [
        { kind: "watchdog", name: "Last watchdog run", state: null, value: "unknown" },
        { kind: "watchdog", name: "Open problems", state: null, value: "unknown" },
      ],
      problems: [],
      incidents: null,
    };
  }
  const t = now.getTime();
  const lastRun = all.find((p) => p.key === LAST_RUN_KEY)?.firstSeenAt ?? null;
  const runAge = lastRun ? t - lastRun.getTime() : Infinity;
  const problems = all.filter((p) => p.key !== LAST_RUN_KEY).sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
  // Alerted in this incident: the watchdog counted it as real (it texts on the second failing minute, not on a blip).
  const alerted = (p: (typeof problems)[number]) => p.lastAlertedAt !== null && p.lastAlertedAt >= p.firstSeenAt;
  const open = problems.filter((p) => !p.resolvedAt);

  const rows: StatusRow[] = [
    {
      kind: "watchdog",
      name: "Last watchdog run",
      state: runAge <= RUN_OK_MS ? "ok" : runAge <= RUN_SLOW_MS ? "slow" : "down",
      value: lastRun ? roughAge(runAge) : "never",
    },
    {
      kind: "watchdog",
      name: "Open problems",
      state: open.length === 0 ? "ok" : open.some(alerted) ? "down" : "slow",
      value: open.length ? String(open.length) : "none",
    },
  ];
  const incidents = problems
    .filter((p) => alerted(p) && (!p.resolvedAt || t - p.resolvedAt.getTime() <= INCIDENT_WINDOW_MS))
    .slice(0, INCIDENT_LIMIT)
    .map((p) => ({
      label: problemLabel(p.key),
      open: !p.resolvedAt,
      started: roughAge(t - p.firstSeenAt.getTime()),
      resolved: p.resolvedAt ? roughAge(t - p.resolvedAt.getTime()) : null,
    }));
  // Newest first, with checks the page has no words for after the ones it does.
  const labels = [...new Set(open.map((p) => problemLabel(p.key)))];
  const generic = problemLabel("");
  return { rows, problems: [...labels.filter((l) => l !== generic), ...labels.filter((l) => l === generic)], incidents };
}

/**
 * One round of the public status board. Each part fails on its own: a broken query shows "unknown" on
 * its rows, and dependency checks that can't run at all leave no service rows (which reads as down).
 */
export async function loadBoard(d: BoardDeps): Promise<Board> {
  const [services, texting, watchdog] = await Promise.all([serviceRows(d), textingRows(d.db, d.now), watchdogSection(d.db, d.now)]);
  return { rows: [...services, ...texting, ...watchdog.rows], problems: watchdog.problems, incidents: watchdog.incidents };
}

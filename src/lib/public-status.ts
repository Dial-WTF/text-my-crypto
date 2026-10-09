import { type Chain, CHAINS } from "@/lib/chains";
import type { Check } from "@/lib/health";

export type ServiceState = "ok" | "slow" | "down";
export type StatusRow = { kind: "service" | "network"; name: string; state: ServiceState };

/** A check that answers but takes longer than this counts as slow. */
export const SLOW_MS = 2_000;

/** How long one round of checks is reused, so visitors can't make the page hammer D1 and every RPC. */
export const STATUS_TTL_MS = 60_000;

const SERVICES: Record<string, string> = {
  d1: "Database",
  payphoneAuth: "Texting (Payphone)",
};

export function stateOf(check: Check, slowMs = SLOW_MS): ServiceState {
  if (!check.ok) return "down";
  return check.ms > slowMs ? "slow" : "ok";
}

function chainOf(key: string): Chain | null {
  const m = /^(\w+)Balance$/.exec(key);
  const chain = m?.[1];
  return chain && (CHAINS as readonly string[]).includes(chain) ? (chain as Chain) : null;
}

/**
 * The public face of dependencyChecks: a service or network name and ok/slow/down, nothing else. Detail
 * text, timings and RPC hosts are dropped, and checks this page doesn't know are left out rather than
 * shown under their internal names.
 */
export function publicRows(checks: Record<string, Check>, networkName: (chain: Chain) => string): StatusRow[] {
  const services: StatusRow[] = [];
  const networks: StatusRow[] = [];
  for (const [key, check] of Object.entries(checks)) {
    const service = SERVICES[key];
    if (service) {
      services.push({ kind: "service", name: service, state: stateOf(check) });
      continue;
    }
    const chain = chainOf(key);
    if (chain) networks.push({ kind: "network", name: networkName(chain), state: stateOf(check) });
  }
  return [...services, ...networks];
}

/** The worst state on the board. No rows at all means the checks couldn't run, which is down. */
export function overall(rows: StatusRow[]): ServiceState {
  if (rows.length === 0 || rows.some((r) => r.state === "down")) return "down";
  return rows.some((r) => r.state === "slow") ? "slow" : "ok";
}

export const STATE_WORDS: Record<ServiceState, { label: string; summary: string }> = {
  ok: { label: "ok", summary: "Everything is working." },
  slow: { label: "slow", summary: "Everything works, but something is answering slowly. Payments may take longer than usual." },
  down: { label: "down", summary: "Something is down. Texts and payments that need it will wait or fail until it's back." },
};

/**
 * Reuses one result for `ttlMs`, and one in-flight load for everyone who asks while it runs. A load
 * that throws is not kept, so the next visitor tries again. `ageMs` is how old the result was when asked.
 */
export function cachedFor<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<{ value: T; at: number; ageMs: number }> {
  let entry: { at: number; value: Promise<T> } | undefined;
  return async () => {
    const t = now();
    if (!entry || t - entry.at >= ttlMs) {
      const value = load();
      const fresh = { at: t, value };
      entry = fresh;
      value.catch(() => {
        if (entry === fresh) entry = undefined;
      });
    }
    const { at, value } = entry;
    return { value: await value, at, ageMs: t - at };
  };
}

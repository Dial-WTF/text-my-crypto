import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { type Adapters, errorText } from "@/lib/settlement/types";

export type Check = { ok: boolean; ms: number; detail?: string };

export async function timed(fn: () => Promise<string | undefined>): Promise<Check> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Date.now() - start, ...(detail ? { detail } : {}) };
  } catch (e) {
    const message = errorText(e);
    return { ok: false, ms: Date.now() - start, detail: message.replace(/\d{7,}/g, "…").slice(0, 300) };
  }
}

const SOLANA_PROBE = "11111111111111111111111111111111";
const EVM_PROBE = "0x000000000000000000000000000000000000dEaD";

/**
 * Read-only dependency checks: D1 answers, the Payphone key works, and every chain's RPC returns a
 * balance. Never sends a text and never moves money. Keys: d1, payphoneAuth (only with a key),
 * <chain>Balance.
 */
export async function dependencyChecks(deps: {
  db: Db;
  payphone: { baseUrl: string; apiKey?: string };
  adapters: Adapters;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, Check>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const checks: Record<string, Check> = {
    d1: await timed(async () => {
      await deps.db.run(sql`select 1`);
      return undefined;
    }),
  };
  const apiKey = deps.payphone.apiKey;
  if (apiKey) {
    checks.payphoneAuth = await timed(async () => {
      const res = await fetchImpl(`${deps.payphone.baseUrl}/api/v1/numbers/mine`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return undefined;
    });
  }
  for (const [chain, adapter] of Object.entries(deps.adapters)) {
    if (!adapter) continue;
    const address = chain === "solana" ? SOLANA_PROBE : EVM_PROBE;
    checks[`${chain}Balance`] = await timed(async () => `${await adapter.getBalance(address)}`);
  }
  return checks;
}

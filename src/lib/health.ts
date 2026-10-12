import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { isUsdAmount, usdToBaseUnits } from "@/lib/money";
import type { LlmInterpreter } from "@/lib/operator/brain";
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Partial<Record> allows an explicit undefined, which Object.entries hides
    if (!adapter) continue;
    checks[`${chain}Balance`] = await timed(async () => {
      // Zcash can only read wallets its service holds, so it probes the treasury.
      const address = chain === "solana" ? SOLANA_PROBE : chain === "zcash" ? await adapter.treasuryAddress() : EVM_PROBE;
      return `${await adapter.getBalance(address)}`;
    });
  }
  return checks;
}

/** The one sample text the language model check reads. It must come back as "send $5". */
export const LLM_SAMPLE = "can u pay alex five bucks for lunch";

/** Runs LLM_SAMPLE through the operator's model. It costs a model call, so callers decide how often. */
export async function llmCheck(llm: LlmInterpreter): Promise<Check> {
  const start = Date.now();
  try {
    const r = await llm(LLM_SAMPLE, []);
    const ok = r.intent === "send" && !!r.amountUsd && isUsdAmount(r.amountUsd) && usdToBaseUnits(r.amountUsd) === 5_000_000n;
    return { ok, ms: Date.now() - start, detail: `${r.intent} ${r.counterparty ?? "-"} ${r.amountUsd ?? "-"} "${r.note ?? ""}"` };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, detail: errorText(err).slice(0, 200) };
  }
}

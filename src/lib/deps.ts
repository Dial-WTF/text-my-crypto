import type { BotDeps } from "@/lib/bot/types";
import { getDb } from "@/lib/db/client";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type Env, env } from "@/lib/env";
import { usdToBaseUnits } from "@/lib/money";
import { gatewayInterpreter, type LlmInterpreter, noLlm, workersAiInterpreter } from "@/lib/operator/brain";
import { getAdapters } from "@/lib/settlement";
import { logSender, payphoneSender } from "@/lib/sms/payphone";

/** The Worker's "ai" binding, or undefined outside a Worker (scripts, tests). */
function aiBinding(): Ai | undefined {
  try {
    return getCloudflareContext().env.AI;
  } catch {
    return undefined;
  }
}

/**
 * Workers AI through the binding; else Workers AI over REST with a token; else AI Gateway if keyed;
 * else none (the grammar still handles every money command).
 */
function operatorModel(e: Env): LlmInterpreter {
  const binding = aiBinding();
  if (binding) return workersAiInterpreter({ binding }, e.WORKERS_AI_MODEL);
  if (e.CLOUDFLARE_ACCOUNT_ID && e.WORKERS_AI_API_TOKEN) {
    return workersAiInterpreter({ accountId: e.CLOUDFLARE_ACCOUNT_ID, apiKey: e.WORKERS_AI_API_TOKEN }, e.WORKERS_AI_MODEL);
  }
  return e.AI_GATEWAY_API_KEY ? gatewayInterpreter(e.DIAL_OPERATOR_MODEL) : noLlm;
}

export function botDeps(): BotDeps {
  const e = env();
  return {
    db: getDb(),
    sendSms:
      e.SMS_MODE === "payphone" && e.PAYPHONE_API_KEY
        ? payphoneSender({ baseUrl: e.PAYPHONE_BASE_URL, apiKey: e.PAYPHONE_API_KEY, from: e.DIAL_OPERATOR_NUMBER })
        : logSender,
    llm: operatorModel(e),
    adapters: getAdapters(),
    appUrl: e.APP_URL,
    operatorNumber: e.DIAL_OPERATOR_NUMBER,
    now: () => new Date(),
    walletKey: e.WALLET_ENCRYPTION_KEY,
    perTxCap: usdToBaseUnits(e.PER_TX_CAP_USD),
    perDayCap: usdToBaseUnits(e.PER_DAY_CAP_USD),
    passkeyThreshold: usdToBaseUnits(e.PASSKEY_THRESHOLD_USD),
    escrowTtlDays: e.ESCROW_TTL_DAYS,
    // The signup drip is test money. On mainnet it would be real dollars, so there is none.
    dripAmount: e.NETWORK === "testnet" ? usdToBaseUnits(e.SIGNUP_DRIP_USD) : 0n,
    network: e.NETWORK,
  };
}

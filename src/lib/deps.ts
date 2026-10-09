import type { BotDeps } from "@/lib/bot/types";
import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { usdToBaseUnits } from "@/lib/money";
import { gatewayInterpreter, noLlm } from "@/lib/operator/brain";
import { getAdapters } from "@/lib/settlement";
import { logSender, payphoneSender } from "@/lib/sms/payphone";

export function botDeps(): BotDeps {
  const e = env();
  return {
    db: getDb(),
    sendSms:
      e.SMS_MODE === "payphone" && e.PAYPHONE_API_KEY
        ? payphoneSender({ baseUrl: e.PAYPHONE_BASE_URL, apiKey: e.PAYPHONE_API_KEY, from: e.DIAL_OPERATOR_NUMBER })
        : logSender,
    llm: e.AI_GATEWAY_API_KEY ? gatewayInterpreter(e.DIAL_OPERATOR_MODEL) : noLlm,
    adapters: getAdapters(),
    appUrl: e.APP_URL,
    operatorNumber: e.DIAL_OPERATOR_NUMBER,
    now: () => new Date(),
    walletKey: e.WALLET_ENCRYPTION_KEY,
    perTxCap: usdToBaseUnits(e.PER_TX_CAP_USD),
    perDayCap: usdToBaseUnits(e.PER_DAY_CAP_USD),
    passkeyThreshold: usdToBaseUnits(e.PASSKEY_THRESHOLD_USD),
    escrowTtlDays: e.ESCROW_TTL_DAYS,
    dripAmount: usdToBaseUnits(e.SIGNUP_DRIP_USD),
    network: e.NETWORK,
  };
}

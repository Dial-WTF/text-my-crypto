import { logOutbound } from "@/lib/sms/log";
import type { BotDeps } from "./types";

/** Sends an SMS and logs it. Throws if the send fails. */
export async function text(deps: Pick<BotDeps, "db" | "sendSms">, phone: string, body: string): Promise<void> {
  await deps.sendSms(phone, body);
  await logOutbound(deps.db, phone, body);
}

/** Best-effort SMS for receipts and notices: a failed text never undoes a payment. */
export async function notify(deps: Pick<BotDeps, "db" | "sendSms">, phone: string, body: string): Promise<void> {
  try {
    await text(deps, phone, body);
  } catch (e) {
    console.error("notify failed", e);
  }
}

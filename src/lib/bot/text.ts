import { logOutbound } from "@/lib/sms/log";
import { isOptedOut } from "@/lib/sms/optout";
import type { BotDeps } from "./types";

type TextDeps = Pick<BotDeps, "db" | "sendSms">;

/**
 * Sends an SMS and logs it. Numbers that texted STOP are never texted, except for the one
 * opt-out confirmation (`force`). Returns whether a message went out. Throws if the send fails.
 */
export async function text(deps: TextDeps, phone: string, body: string, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!opts.force && (await isOptedOut(deps.db, phone))) return false;
  await deps.sendSms(phone, body);
  await logOutbound(deps.db, phone, body);
  return true;
}

/** Best-effort SMS for receipts and notices: a failed text never undoes a payment. */
export async function notify(deps: TextDeps, phone: string, body: string): Promise<boolean> {
  try {
    return await text(deps, phone, body);
  } catch (e) {
    console.error("notify failed", e);
    return false;
  }
}

import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { InboundSms } from "./inbound";
import { claimInbound, finishInbound, releaseInbound } from "./log";

export type ProcessOutcome = "handled" | "duplicate" | "busy";

/**
 * Handles one queued inbound text at least once. The message is only marked handled after the bot
 * finished with it, so a delivery that fails halfway (say after logging but before the reply went
 * out) is handled again on the next delivery instead of being skipped as a duplicate.
 * Throws when handling fails; the caller retries.
 */
export async function processInbound(deps: BotDeps, msg: InboundSms): Promise<ProcessOutcome> {
  const claim = await claimInbound(deps.db, msg, deps.now());
  if (claim.kind === "handled") return "duplicate";
  if (claim.kind === "busy") return "busy";
  try {
    await handleInbound(deps, { ...msg, claim: claim.claimId });
  } catch (e) {
    await releaseInbound(deps.db, msg.dedupeKey, claim.claimId).catch(() => {});
    throw e;
  }
  await finishInbound(deps.db, msg.dedupeKey, claim.claimId, deps.now());
  return "handled";
}

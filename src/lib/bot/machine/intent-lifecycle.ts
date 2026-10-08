import type { Intent } from "@/lib/db/schema";

export type IntentStatus = Intent["status"];

/**
 * Every allowed PaymentIntent status change, and what causes it. The functions in `src/lib/intents.ts`
 * perform these with conditional UPDATEs, so a transition happens at most once even under concurrency.
 */
export const INTENT_TRANSITIONS = {
  pending: {
    settling: "payer approves (code or passkey) before expiry",
    declined: "payer says NO, or the creator says nevermind",
    failed: "approval found too little balance",
  },
  settling: {
    settled: "transfer confirmed (direct payment, claim or withdrawal)",
    escrowed: "transfer into the per-payment escrow confirmed",
    refunded: "escrow refund confirmed",
    failed: "transfer failed; nothing moved",
  },
  escrowed: {
    settling: "recipient claims with the texted code, or sender reclaims after expiry",
  },
  settled: {},
  refunded: {},
  failed: {},
  declined: {},
} as const satisfies Record<IntentStatus, Partial<Record<IntentStatus, string>>>;

export function canTransition(from: IntentStatus, to: IntentStatus): boolean {
  return to in INTENT_TRANSITIONS[from];
}

export const TERMINAL: IntentStatus[] = (Object.keys(INTENT_TRANSITIONS) as IntentStatus[]).filter(
  (s) => Object.keys(INTENT_TRANSITIONS[s]).length === 0,
);

import type { Chain } from "@/lib/chains";
import { ChainDownError, type EscrowLookup, type SettleResult } from "./types";

/**
 * The transfer was broadcast, but its receipt didn't come back in time. It may still land, so a caller
 * must not treat it as "nothing moved" (for a drip: don't give the drip back to be sent again).
 * Extends ChainDownError so guardAdapter passes it through unwrapped and the bot still says the chain is slow.
 */
export class TransferUnconfirmedError extends ChainDownError {
  constructor(
    chain: Chain,
    readonly txHash: string,
    cause: unknown,
  ) {
    super(chain, cause);
    this.name = "TransferUnconfirmedError";
  }
}

/**
 * A send or drip went out to the chain's service and no definite answer came back (a timeout, a dropped
 * connection, a 5xx). The money may have moved. Never record it as failed: retry with the same arguments,
 * which only adapters with idempotent sends throw this for.
 */
export class SettlementUnknownError extends ChainDownError {
  constructor(chain: Chain, cause: unknown) {
    super(chain, cause);
    this.name = "SettlementUnknownError";
  }
}

/**
 * After a failed escrow funding: did the money move? Funded when the chain holds this sender's escrow
 * for this amount. Failed when the send certainly didn't land, or nothing is there and the transaction
 * can't land any more. Anything else (the RPC broke while it could still land) is unconfirmed.
 */
export function fundingVerdict(args: {
  definite: boolean;
  found: EscrowLookup | null;
  sender: string;
  amount: bigint;
  expired: boolean;
}): { kind: "funded"; result: SettleResult } | { kind: "failed" } | { kind: "unconfirmed" } {
  const { found } = args;
  if (found?.state === "open" && found.funded && found.sender === args.sender && found.amount === args.amount) {
    return { kind: "funded", result: found.funded };
  }
  if (args.definite) return { kind: "failed" };
  if (found?.state === "none" && args.expired) return { kind: "failed" };
  return { kind: "unconfirmed" };
}

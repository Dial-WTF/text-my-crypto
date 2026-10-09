import type { Chain } from "@/lib/chains";
import { ChainDownError } from "./types";

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

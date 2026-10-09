import type { Chain } from "@/lib/chains";
import { errorText } from "./redact";

export { errorText, redactUrls } from "./redact";

export type SettleResult = { txHash: string; explorerUrl: string };

export interface SettlementAdapter {
  chain: Chain;
  tokenId: string;
  isValidAddress(address: string): boolean;
  createWallet(): Promise<{ address: string; secret: Uint8Array<ArrayBuffer> }>;
  getBalance(address: string): Promise<bigint>;
  /** Moves `amount` from the wallet behind `fromSecret` to `to`. `closeSource` empties and closes the source token account (escrow release/refund). */
  settle(args: {
    fromSecret: Uint8Array<ArrayBuffer>;
    to: string;
    amount: bigint;
    memo: string;
    closeSource?: boolean;
  }): Promise<SettleResult>;
  fund(to: string, amount: bigint): Promise<SettleResult>;
  /** The operator's treasury on this chain: funds signups and pays fees. Public, so anyone can audit it. */
  treasuryAddress(): Promise<string>;
  /** On-chain escrow for payments to people not on Dial yet. Absent: escrow is a server-held wallet. */
  escrow?: EscrowProgram;
}

/**
 * An escrow program: the money waits in a vault keyed by the intent id. The operator's attestor key can
 * release it to the recipient before expiry; after expiry it can only go back to the sender.
 * `claim` and `refund` are idempotent: if the escrow already closed the same way, they return that transaction.
 */
export interface EscrowProgram {
  programId: string;
  /** Where the money will sit. Known before the escrow exists, so it can go on the intent. */
  vaultAddress(intentId: string): Promise<string>;
  create(args: { fromSecret: Uint8Array<ArrayBuffer>; intentId: string; amount: bigint; expiresAt: Date }): Promise<SettleResult>;
  claim(args: { intentId: string; to: string }): Promise<SettleResult>;
  refund(args: { intentId: string }): Promise<SettleResult>;
}

export type Adapters = Partial<Record<Chain, SettlementAdapter>>;

/** The chain's RPC didn't answer (rate limit, 403, timeout). Nothing moved; the person should try again later. */
export class ChainDownError extends Error {
  constructor(
    readonly chain: Chain,
    cause: unknown,
  ) {
    super(`${chain} RPC unavailable: ${errorText(cause)}`.slice(0, 300));
    this.name = "ChainDownError";
  }
}

/** Wraps an adapter so read and funding failures surface as ChainDownError. `settle` failures stay as-is: they're recorded on the payment. */
export function guardAdapter(adapter: SettlementAdapter): SettlementAdapter {
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (e) {
        throw e instanceof ChainDownError ? e : new ChainDownError(adapter.chain, e);
      }
    };
  return { ...adapter, getBalance: guard(adapter.getBalance), fund: guard(adapter.fund) };
}

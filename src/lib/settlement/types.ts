import type { Chain } from "@/lib/chains";

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
}

export type Adapters = Partial<Record<Chain, SettlementAdapter>>;

/** The chain's RPC didn't answer (rate limit, 403, timeout). Nothing moved; the person should try again later. */
export class ChainDownError extends Error {
  constructor(
    readonly chain: Chain,
    cause: unknown,
  ) {
    super(`${chain} RPC unavailable: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300));
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

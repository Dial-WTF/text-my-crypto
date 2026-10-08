import type { Chain } from "@/lib/chains";

export type SettleResult = { txHash: string; explorerUrl: string };

export interface SettlementAdapter {
  chain: Chain;
  tokenId: string;
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

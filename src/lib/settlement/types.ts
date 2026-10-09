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
  /** HyperEVM only: deposits into HyperCore spot balances. Absent until the deposit contract is deployed. */
  hyperCore?: HyperCoreBridge;
}

/** Moves USDC from a HyperEVM wallet into a HyperCore spot balance, in one transaction the treasury pays for. */
export interface HyperCoreBridge {
  /** "HyperCore testnet". */
  network: string;
  /** Moves `amount` from the wallet behind `fromSecret` into `to`'s HyperCore spot balance. `memo` is the payment id. */
  deposit(args: { fromSecret: Uint8Array<ArrayBuffer>; to: string; amount: bigint; memo: string }): Promise<SettleResult>;
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
  /** What the chain says about this intent's escrow, for settling payments whose outcome we didn't see. */
  lookup(intentId: string): Promise<EscrowLookup>;
}

export type EscrowLookup =
  | { state: "open"; sender: string; amount: bigint; expiresAt: Date; funded: SettleResult | null }
  | { state: "claimed" | "refunded"; result: SettleResult }
  | { state: "none" };

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

/** The transaction's blockhash expired before it landed, so it never will. Nothing moved. */
export class NotLandedError extends Error {
  constructor(sig: string) {
    super(`Solana tx ${sig} expired without landing`);
    this.name = "NotLandedError";
  }
}

/** We can't tell whether an escrow's funding landed (the RPC stopped answering). Check the chain before calling it failed. */
export class EscrowUnconfirmedError extends Error {
  constructor(intentId: string, cause: unknown) {
    super(`Escrow for ${intentId} unconfirmed: ${errorText(cause)}`.slice(0, 300), { cause });
    this.name = "EscrowUnconfirmedError";
  }
}

/** The escrow already closed the other way: claimed when we tried to refund, or refunded when we tried to claim. */
export class EscrowClosedError extends Error {
  constructor(
    readonly outcome: "claimed" | "refunded",
    readonly result: SettleResult,
  ) {
    super(`Escrow was already ${outcome} in ${result.txHash}`);
    this.name = "EscrowClosedError";
  }
}

/** The escrow program refused a claim because the escrow has expired. It can only go back to the sender now. */
export class EscrowExpiredError extends Error {
  constructor(intentId: string) {
    super(`Escrow for ${intentId} has expired; it can only be refunded`);
    this.name = "EscrowExpiredError";
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

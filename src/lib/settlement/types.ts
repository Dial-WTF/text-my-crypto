import type { Chain } from "@/lib/chains";
import type { AssetTransfers, Capabilities, TransferLeg } from "./capabilities";
import { errorText } from "./redact";

export { errorText, redactUrls } from "./redact";

export type SettleResult = { txHash: string; explorerUrl: string | null };

/** Where a payment goes: another Dial wallet, a per-payment escrow wallet, or an address outside Dial. */
type RecipientKind = "dial" | "escrow" | "outside";

/** Send, hold and check a stablecoin on one chain, plus whatever chain-native modules it carries (capabilities.ts). */
export interface SettlementAdapter extends Capabilities {
  chain: Chain;
  tokenId: string;
  isValidAddress(address: string): boolean;
  createWallet(): Promise<{ address: string; secret: Uint8Array<ArrayBuffer> }>;
  getBalance(address: string): Promise<bigint>;
  /**
   * Moves `amount` from the wallet behind `fromSecret` to `to`. `closeSource` empties and closes the source
   * token account (escrow release/refund). `escrow` says `to` is a per-payment escrow wallet, for chains
   * where the sender also covers what moving it on will cost.
   */
  settle(args: {
    fromSecret: Uint8Array<ArrayBuffer>;
    to: string;
    amount: bigint;
    memo: string;
    closeSource?: boolean;
    escrow?: boolean;
  }): Promise<SettleResult>;
  fund(to: string, amount: bigint): Promise<SettleResult>;
  /**
   * What a payment must carry on top of `amount`, beyond the fee `getBalance` already holds back, by
   * where it goes: another Dial wallet, a per-payment escrow wallet, or outside Dial. Absent: nothing.
   * Zcash only, where payments between its wallets carry the fees the recipient will need to move them on.
   */
  carriedFees?(to: RecipientKind): bigint;
  /** The operator's treasury on this chain: funds signups and pays fees. Public, so anyone can audit it. */
  treasuryAddress(): Promise<string>;
  /**
   * What became of a transfer that went out without an answer (`settle` threw TransferUnconfirmedError):
   * it landed, it failed, or it can still land. `sentAt` is about when it went out, for chains where a
   * transfer stops being able to land after a while. `legs` are what the transaction was meant to deliver, for
   * chains where it can succeed without delivering some of them (see HeldBackError). Absent: such transfers
   * wait for a person to look.
   */
  transferOutcome?(
    txHash: string,
    at: { sentAt: Date; now: Date },
    legs?: readonly Pick<TransferLeg, "to" | "amount">[],
  ): Promise<TransferOutcome>;
}

/** `heldBack`: indexes into the `legs` asked about that the chain kept from their recipients (see HeldBackError). */
export type TransferOutcome = { state: "landed"; result: SettleResult; heldBack?: number[] } | { state: "failed" } | { state: "pending" };

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
  /**
   * `senderSecret`: the sender's wallet key, for programs that refund only on the sender's signature
   * (Arbitrum's dial_escrow). Programs anyone can crank (Solana's) ignore it.
   */
  refund(args: { intentId: string; senderSecret?: Uint8Array<ArrayBuffer> }): Promise<SettleResult>;
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

/**
 * The transaction landed, but the chain kept some of its transfers from their recipients: a Tempo receive or
 * transfer policy blocked them, and the network holds that money for the sender to reclaim. The other legs
 * were delivered. `heldBack` holds the indexes of the legs that weren't.
 */
export class HeldBackError extends Error {
  constructor(
    readonly result: SettleResult,
    readonly heldBack: number[],
    recipients: string[],
  ) {
    super(`tempo tx ${result.txHash} did not deliver to ${recipients.join(", ")} (blocked by receive policy?)`);
    this.name = "HeldBackError";
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

/**
 * Wraps an adapter so read, wallet-creation and funding failures surface as ChainDownError. `settle`
 * failures stay as-is: they're recorded on the payment.
 */
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
  const assets: AssetTransfers | undefined = adapter.assets && { ...adapter.assets, balanceOf: guard(adapter.assets.balanceOf.bind(adapter.assets)) };
  return {
    ...adapter,
    createWallet: guard(adapter.createWallet.bind(adapter)),
    getBalance: guard(adapter.getBalance.bind(adapter)),
    fund: guard(adapter.fund.bind(adapter)),
    ...(assets ? { assets } : {}),
  };
}

/**
 * What moves a payment's token: the stablecoin adapter itself, or its `assets` module for a token such as a
 * stock. Amounts are in the payment's units either way.
 */
export function moverFor(adapter: SettlementAdapter, token: string): Pick<SettlementAdapter, "getBalance" | "settle"> {
  if (token === adapter.tokenId) return adapter;
  const assets = adapter.assets;
  const asset = assets?.list().find((a) => a.address.toLowerCase() === token.toLowerCase());
  if (!assets || !asset) throw new Error(`${adapter.chain} cannot move token ${token}`);
  return {
    getBalance: (address) => assets.balanceOf(address, asset),
    settle: ({ fromSecret, to, amount, memo }) => assets.transfer({ fromSecret, to, asset, amount, memo }),
  };
}

import type { Chain } from "@/lib/chains";
import type { Adapters, EscrowProgram, SettlementAdapter, SettleResult } from "./types";

/**
 * Chain-native features as modules. Every adapter can send, hold and check a stablecoin; on top of that,
 * a chain carries the modules its network makes possible. The operator, MCP tools and public pages never
 * ask "is this Tempo?": they ask "which chain can batch?" and use what is there. A new feature on a chain
 * is one module on its adapter, plus one entry in FEATURES below.
 */
export interface Capabilities {
  /** Payments to people not on Dial wait in an on-chain vault: the attestor releases, the sender refunds after expiry. */
  escrow?: EscrowProgram;
  /** Human-readable names for addresses (ENS on Ethereum, Basenames on Base). */
  names?: NameService;
  /** Several transfers settled as one transaction: all of them land or none do (Tempo batched calls). */
  batch?: BatchTransfer;
  /** Pay links any wallet can sign and pay (Solana Actions / Blinks). */
  actions?: PaymentActions;
  /** Sends whose amount, parties and memo are encrypted on-chain (Zcash shielded pool). */
  shielded?: ShieldedTransfer;
  /** Moves money into the chain's own trading venue and reads it back (HyperEVM to HyperCore). */
  venue?: VenueTransfer;
  /** Assets beyond the settlement stablecoin, such as tokenized stocks on Robinhood Chain. */
  assets?: AssetTransfers;
}

export interface NameService {
  /** Name endings this service answers for, longest first: [".base.eth"] or [".eth"]. */
  suffixes: string[];
  /** The address a name points to now, or null. Resolve once, when the payment is created, and store it. */
  resolve(name: string): Promise<string | null>;
  /** The primary name for an address, or null. For display only, never for routing money. */
  reverse?(address: string): Promise<string | null>;
}

export type TransferLeg = { to: string; amount: bigint; memo: string };

export interface BatchTransfer {
  /** The most legs one transaction carries. */
  maxLegs: number;
  /** Settles every leg in one transaction from the wallet behind `fromSecret`. Atomic: all land or none. */
  settleBatch(args: { fromSecret: Uint8Array<ArrayBuffer>; legs: TransferLeg[] }): Promise<SettleResult>;
}

export interface PaymentActions {
  /** An unsigned transaction paying `recipient` from `payer`, tagged with `reference` so it can be found. Base64. */
  buildPayment(args: { payer: string; recipient: string; amount: bigint; reference: string; memo: string }): Promise<string>;
  /** Confirmed payments carrying `reference`, oldest first. Empty until one lands. */
  findByReference(reference: string): Promise<Array<SettleResult & { payer: string; amount: bigint }>>;
}

export interface ShieldedTransfer {
  /** The pool payments go through, for receipts: "Orchard". */
  pool: string;
  /** True when this chain's sends are shielded by default; false when shielding is opt-in per payment. */
  byDefault: boolean;
}

export interface VenueTransfer {
  /** The venue's name for people: "HyperCore". */
  name: string;
  /** Moves `amount` from the wallet behind `fromSecret` into `to`'s balance on the venue. */
  deposit(args: { fromSecret: Uint8Array<ArrayBuffer>; to: string; amount: bigint; memo: string }): Promise<SettleResult>;
  /** `address`'s stablecoin balance on the venue. */
  balance(address: string): Promise<bigint>;
}

export type Asset = { symbol: string; name: string; address: string; decimals: number };

/**
 * Amounts here are the payment's units, millionths of a token (0.1 TSLA is 100_000), so they fit a payment
 * row; the module scales to the token's `decimals` on chain.
 */
export interface AssetTransfers {
  list(): Asset[];
  balanceOf(address: string, asset: Asset): Promise<bigint>;
  transfer(args: { fromSecret: Uint8Array<ArrayBuffer>; to: string; asset: Asset; amount: bigint; memo: string }): Promise<SettleResult>;
}

export type FeatureId = keyof Capabilities;

/** What each module is called and does, in plain words, for replies, MCP tool descriptions and public pages. */
export const FEATURES: Record<FeatureId, { title: string; summary: string }> = {
  escrow: { title: "On-chain escrow", summary: "Money for someone not on Dial waits in a program, not with Dial." },
  names: { title: "Names", summary: "Pay or withdraw to a name instead of an address." },
  batch: { title: "Split payments", summary: "One payment to several people, settled as one transaction." },
  actions: { title: "Wallet pay links", summary: "Anyone can pay a Dial pay link from their own wallet." },
  shielded: { title: "Private sends", summary: "Amount, parties and memo are encrypted on-chain." },
  venue: { title: "Trading venue transfers", summary: "Move money into the chain's own trading venue by text." },
  assets: { title: "Asset gifts", summary: "Send assets beyond the stablecoin, like tokenized stocks." },
};

const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

/** The modules an adapter carries. */
export function featuresOf(adapter: SettlementAdapter): FeatureId[] {
  return FEATURE_IDS.filter((id) => adapter[id] !== undefined);
}

/**
 * The chain to use for a feature: `preferred` if it carries the module, else the first enabled chain that
 * does, else null. This is how "split", "privately" or a name ending pick a chain without naming one.
 */
export function chainWith<F extends FeatureId>(
  adapters: Adapters,
  feature: F,
  preferred?: Chain,
): { chain: Chain; adapter: SettlementAdapter; module: NonNullable<Capabilities[F]> } | null {
  const candidates = preferred ? [preferred, ...Object.keys(adapters)] : Object.keys(adapters);
  for (const chain of candidates as Chain[]) {
    const adapter = adapters[chain];
    const found = adapter?.[feature];
    if (adapter && found !== undefined) return { chain, adapter, module: found as NonNullable<Capabilities[F]> };
  }
  return null;
}

/** The name service whose suffix matches `name` (longest suffix wins, so ".base.eth" beats ".eth"). */
export function nameServiceFor(
  adapters: Partial<Record<Chain, Pick<SettlementAdapter, "names">>>,
  name: string,
): { chain: Chain; names: NameService } | null {
  const lower = name.toLowerCase();
  let best: { chain: Chain; names: NameService; length: number } | null = null;
  for (const [chain, adapter] of Object.entries(adapters) as Array<[Chain, Pick<SettlementAdapter, "names"> | undefined]>) {
    const names = adapter?.names;
    const suffix = names?.suffixes.find((s) => lower.endsWith(s) && lower.length > s.length);
    if (names && suffix && (!best || suffix.length > best.length)) best = { chain, names, length: suffix.length };
  }
  return best && { chain: best.chain, names: best.names };
}

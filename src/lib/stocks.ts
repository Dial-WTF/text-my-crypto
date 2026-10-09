import type { Chain } from "@/lib/chains";
import { formatUsd } from "@/lib/money";
import { money, namesItsCoin } from "@/lib/settlement/amounts";
import { NETWORKS, type Network, REGISTRY, type StockToken } from "@/lib/settlement/registry";

/**
 * Stock amounts on a payment are millionths of a token, like dollars are millionths of a dollar:
 * 0.1 TSLA is 100_000. On chain a stock token has 18 decimals, so the adapter scales by 10^12.
 */
export const STOCK_ONCHAIN_SCALE = 10n ** 12n;

const SHARES_RE = /^(\d{1,6})(?:\.(\d{1,6}))?$/;

/** "0.1", "2", "0.000001": up to six decimals, like a share count. */
export function isShareAmount(s: string): boolean {
  return SHARES_RE.test(s.trim());
}

export function sharesToUnits(s: string): bigint {
  const m = SHARES_RE.exec(s.trim());
  if (!m || m[1] === undefined) throw new RangeError(`Bad share amount: ${s}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** 100_000 → "0.1", 5_000_000 → "5". */
export function formatShares(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The stock tokens people can send on this chain and network. */
export function stocksOn(chain: Chain, network: Network): readonly StockToken[] {
  const entry = REGISTRY[chain][network];
  return entry?.kind === "evm" ? (entry.stocks ?? []) : [];
}

export function findStock(chain: Chain, network: Network, symbol: string): StockToken | null {
  const want = symbol.toUpperCase();
  return stocksOn(chain, network).find((s) => s.symbol === want) ?? null;
}

const ALL_STOCKS: Array<{ chain: Chain; stock: StockToken }> = (Object.keys(REGISTRY) as Chain[]).flatMap((chain) =>
  NETWORKS.flatMap((network) => stocksOn(chain, network).map((stock) => ({ chain, stock }))),
);

/** Every stock token address in the registry: payments in them are not dollars, so dollar sums leave them out. */
export const STOCK_TOKEN_ADDRESSES: readonly string[] = ALL_STOCKS.map((s) => s.stock.address);

/** Tickers that mean a stock even when typed in lowercase ("send alex 1 tsla"). */
export const KNOWN_STOCK_SYMBOLS: ReadonlySet<string> = new Set(ALL_STOCKS.map((s) => s.stock.symbol));

/** The stock a payment moves, or null for the stablecoin. */
export function stockForToken(chain: Chain, token: string): StockToken | null {
  const t = token.toLowerCase();
  return ALL_STOCKS.find((s) => s.chain === chain && s.stock.address.toLowerCase() === t)?.stock ?? null;
}

type Amounted = { chain: Chain; token: string; amount: bigint };

/** A payment's amount as people read it: "0.1 TSLA" for a stock, else the chain's own way (`money`: "$5"). */
export function formatAmount(i: Amounted, network: Network): string {
  const stock = stockForToken(i.chain, i.token);
  return stock ? `${formatShares(i.amount)} ${stock.symbol}` : money(i.amount, i.chain, network);
}

/** The dollar amount for caps and passkey thresholds. Null for stocks: testnet has no price for them. */
export function usdAmount(i: Amounted): bigint | null {
  return stockForToken(i.chain, i.token) ? null : i.amount;
}

/**
 * Several payments' total, per asset: "$7" (as `money` reads it when they share a chain: "$5 (0.1 TAZ)" on
 * Zcash), or "$5 USDC and 0.1 TSLA" once a stock is in the mix.
 */
export function formatTotals(items: Amounted[], network: Network): string {
  let usd = 0n;
  const chains = new Set<Chain>();
  const shares = new Map<string, bigint>();
  for (const i of items) {
    const stock = stockForToken(i.chain, i.token);
    if (stock) shares.set(stock.symbol, (shares.get(stock.symbol) ?? 0n) + i.amount);
    else {
      usd += i.amount;
      chains.add(i.chain);
    }
  }
  const [only, ...others] = chains;
  const dollars = only && others.length === 0 ? money(usd, only, network) : formatUsd(usd);
  if (shares.size === 0) return dollars;
  const parts = [...(usd > 0n ? [namesItsCoin(dollars) ? dollars : `${dollars} USDC`] : []), ...[...shares].map(([s, n]) => `${formatShares(n)} ${s}`)];
  return parts.join(" and ");
}

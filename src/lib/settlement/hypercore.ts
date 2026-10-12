import { ChainDownError } from "./types";

export type Fetch = typeof fetch;

/** Prices come from mainnet: testnet mids are test markets, not what anything trades at. */
export const PRICE_INFO_URL = "https://api.hyperliquid.xyz/info";

/** One POST to Hyperliquid's public info API. Anything but a JSON answer means it isn't answering. */
async function info(url: string, body: Record<string, unknown>, fetchFn: Fetch): Promise<unknown> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Hyperliquid info API answered ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new ChainDownError("hyperevm", e);
  }
}

/** "12.34567891" (HyperCore keeps 8 decimals) to 6-decimal base units, rounding down. */
export function coreUsdToBaseUnits(total: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(total.trim());
  if (!m?.[1]) throw new Error(`Bad HyperCore amount: ${total}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0").slice(0, 6));
}

type SpotBalance = { coin?: unknown; token?: unknown; total?: unknown };

/** USDC in this address's HyperCore spot balance (token 0), in 6-decimal base units. An account HyperCore hasn't seen has none. */
export async function spotUsdc(infoUrl: string, user: string, fetchFn: Fetch = fetch): Promise<bigint> {
  const state = (await info(infoUrl, { type: "spotClearinghouseState", user }, fetchFn)) as { balances?: SpotBalance[] } | null;
  const usdc = state?.balances?.find((b) => b.token === 0 || b.coin === "USDC");
  return typeof usdc?.total === "string" ? coreUsdToBaseUnits(usdc.total) : 0n;
}

/** "BTC", "hype", "$eth" to the coin name Hyperliquid lists. */
export function coinSymbol(raw: string): string {
  return raw.trim().replace(/^\$/, "").toUpperCase();
}

/** The current mid for a Hyperliquid perp ("BTC", "HYPE"), as Hyperliquid prints it, or null when it lists no such market. */
export async function midPrice(coin: string, fetchFn: Fetch = fetch): Promise<string | null> {
  const mids = (await info(PRICE_INFO_URL, { type: "allMids" }, fetchFn)) as Record<string, unknown> | null;
  const mid = mids?.[coinSymbol(coin)];
  return typeof mid === "string" && /^\d+(\.\d+)?$/.test(mid) ? mid : null;
}

/** "82355.5" to "$82,355.50"; small prices keep their digits ("$0.000123"). */
export function formatPrice(mid: string): string {
  const n = Number(mid);
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${mid}`;
}

import type { Network } from "@/lib/settlement/registry";
import { memoizer } from "@/lib/web/memo";

/** Hyperliquid's public info API, per network. Read-only; no key. */
const HYPERLIQUID_INFO: Record<Network, string> = {
  testnet: "https://api.hyperliquid-testnet.xyz/info",
  mainnet: "https://api.hyperliquid.xyz/info",
};

export type Mids = { HYPE: string | null; BTC: string | null };

/** The HYPE and BTC mids from an allMids answer ({ "BTC": "61234.5", … }). Anything missing or odd is null. */
export function pickMids(body: unknown): Mids {
  const all = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const mid = (coin: string) => {
    const v = all[coin];
    return typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null;
  };
  return { HYPE: mid("HYPE"), BTC: mid("BTC") };
}

/** Asked at most every 30 seconds per isolate, however many people open the page. */
const mids = memoizer<Mids>({ ttlMs: 30_000, maxKeys: 4 });

export function loadMids(network: Network, fetcher: typeof fetch = fetch): Promise<Mids> {
  return mids(network, async () => {
    const res = await fetcher(HYPERLIQUID_INFO[network], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
    return pickMids(await res.json());
  });
}

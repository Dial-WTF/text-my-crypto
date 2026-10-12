/**
 * The brand registry: a second theme axis that recolours only accents and fills (see README.md).
 * Adding a brand = one CSS file in ./brands, one @import in ./brands/index.css, and one entry here.
 * Brand ids match the chain ids in src/lib/chains.ts, so a chain page can pass its chain straight in.
 */
export const BRANDS = [
  { id: "solana", label: "Solana" },
  { id: "tempo", label: "Tempo" },
  { id: "base", label: "Base" },
  { id: "ethereum", label: "Ethereum" },
  { id: "arbitrum", label: "Arbitrum" },
  { id: "hyperevm", label: "Hyperliquid" },
  { id: "robinhood", label: "Robinhood Chain" },
  { id: "zcash", label: "Zcash" },
] as const;

export type BrandId = (typeof BRANDS)[number]["id"];

export function isBrandId(value: string): value is BrandId {
  return BRANDS.some((b) => b.id === value);
}

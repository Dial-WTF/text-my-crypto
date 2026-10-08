export const CHAINS = ["solana", "tempo", "base", "ethereum", "arbitrum", "hyperevm", "robinhood", "zcash"] as const;
export type Chain = (typeof CHAINS)[number];

const ALIASES: Record<string, Chain> = {
  sol: "solana",
  solana: "solana",
  tempo: "tempo",
  base: "base",
  eth: "ethereum",
  ethereum: "ethereum",
  arb: "arbitrum",
  arbitrum: "arbitrum",
  hyperliquid: "hyperevm",
  hyperevm: "hyperevm",
  hype: "hyperevm",
  robinhood: "robinhood",
  hood: "robinhood",
  zec: "zcash",
  zcash: "zcash",
};

const LABELS: Record<Chain, string> = {
  solana: "Solana",
  tempo: "Tempo",
  base: "Base",
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  hyperevm: "HyperEVM",
  robinhood: "Robinhood Chain",
  zcash: "Zcash",
};

export function parseChain(word: string): Chain | null {
  return ALIASES[word.trim().toLowerCase()] ?? null;
}

export function chainLabel(c: Chain): string {
  return LABELS[c];
}

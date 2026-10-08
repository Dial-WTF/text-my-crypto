export const CHAINS = ["solana", "tempo", "base", "zcash"] as const;
export type Chain = (typeof CHAINS)[number];

const ALIASES: Record<string, Chain> = {
  sol: "solana",
  solana: "solana",
  tempo: "tempo",
  base: "base",
  zec: "zcash",
  zcash: "zcash",
};

const LABELS: Record<Chain, string> = {
  solana: "Solana",
  tempo: "Tempo",
  base: "Base",
  zcash: "Zcash",
};

export function parseChain(word: string): Chain | null {
  return ALIASES[word.trim().toLowerCase()] ?? null;
}

export function chainLabel(c: Chain): string {
  return LABELS[c];
}

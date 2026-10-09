import { type Chain, chainLabel } from "@/lib/chains";
import { env } from "@/lib/env";
import { type ActiveChain, activeChains, getAdapters } from "@/lib/settlement";
import { type Network, REGISTRY } from "@/lib/settlement/registry";
import { type Adapters, errorText } from "@/lib/settlement/types";

/** The network a chain settles on, e.g. "Solana devnet" or "Base Sepolia". Defaults to the one running now. */
export function networkName(chain: Chain, network: Network = env().NETWORK): string {
  return REGISTRY[chain][network]?.network ?? chainLabel(chain);
}

/** The network running now, or null when the environment can't be read. For public pages that must still render. */
export function runningNetwork(): Network | null {
  try {
    return env().NETWORK;
  } catch {
    return null;
  }
}

/** networkName that never throws: the bare chain name when the environment can't be read. */
export function safeNetworkName(chain: Chain): string {
  const network = runningNetwork();
  return network ? networkName(chain, network) : chainLabel(chain);
}

export type ChainProof = { chain: Chain; network: string; treasury: string; treasuryUrl: string };

/**
 * One row per live chain: the treasury that funds signups and pays every fee. Its explorer page lists
 * every drop, fee and escrow, so anyone can check the ledger against the chain without trusting us.
 * Each chain is asked on its own: one that is down is left out and the rest still show.
 */
export async function chainProofs(
  adapters: Adapters = getAdapters(),
  chains: ActiveChain[] = activeChains(),
): Promise<ChainProof[]> {
  const rows = await Promise.all(
    chains.map(async ({ chain, entry }): Promise<ChainProof | null> => {
      const adapter = adapters[chain];
      if (!adapter) return null;
      try {
        const treasury = await adapter.treasuryAddress();
        return { chain, network: entry.network, treasury, treasuryUrl: entry.explorerAddress(treasury) };
      } catch (e) {
        console.error("chain proof unavailable", chain, errorText(e));
        return null;
      }
    }),
  );
  return rows.filter((r): r is ChainProof => r !== null);
}

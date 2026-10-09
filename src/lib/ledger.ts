import { type Chain, chainLabel } from "@/lib/chains";
import { env } from "@/lib/env";
import { activeChains, getAdapters } from "@/lib/settlement";
import { REGISTRY } from "@/lib/settlement/registry";

/** The network a chain settles on right now, e.g. "Solana devnet" or "Base Sepolia". */
export function networkName(chain: Chain): string {
  return REGISTRY[chain][env().NETWORK]?.network ?? chainLabel(chain);
}

export type ChainProof = {
  chain: Chain;
  network: string;
  treasury: string;
  treasuryUrl: string;
  /** The escrow program holding payments to people not on Dial yet, when the chain uses one. */
  escrowProgram?: { address: string; url: string };
};

/**
 * One row per live chain: the treasury that funds signups and pays every fee, and the escrow program
 * when there is one. Their explorer pages list every drop, fee and escrow, so anyone can check the
 * ledger against the chain without trusting us.
 */
export async function chainProofs(): Promise<ChainProof[]> {
  const adapters = getAdapters();
  const proofs: ChainProof[] = [];
  for (const { chain, entry } of activeChains()) {
    const adapter = adapters[chain];
    if (!adapter) continue;
    const treasury = await adapter.treasuryAddress();
    const program = adapter.escrow?.programId;
    proofs.push({
      chain,
      network: entry.network,
      treasury,
      treasuryUrl: entry.explorerAddress(treasury),
      ...(program ? { escrowProgram: { address: program, url: entry.explorerAddress(program) } } : {}),
    });
  }
  return proofs;
}

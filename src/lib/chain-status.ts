import { type Chain, CHAINS, chainLabel } from "@/lib/chains";
import { type Network, REGISTRY } from "@/lib/settlement/registry";

/**
 * "live": switched on by CHAINS and settling on this network. "wired": the registry has a stablecoin for it,
 * but CHAINS leaves it off. "building": no stablecoin or no adapter on this network yet.
 */
export type ChainState = "live" | "wired" | "building";

export type ChainStatus = {
  chain: Chain;
  state: ChainState;
  /** "Solana devnet", "Tempo Moderato"; the chain's own name where the registry has no entry. */
  network: string;
  /** "Live · devnet", "Wired · Sepolia", "Building". */
  label: string;
};

/** True when the registry can settle this chain on this network: an entry, and a stablecoin for it. */
function settles(chain: Chain, network: Network): boolean {
  const entry = REGISTRY[chain][network];
  return entry !== null && (entry.kind === "solana" || entry.token !== null);
}

/**
 * The chains CHAINS switches on that can settle on this network, in registry order. The one rule for
 * "is this chain on": settlement (activeChains), public pages and /llms.txt all read it from here.
 */
export function enabledChains(chainsSetting: string, network: Network): Chain[] {
  const wanted = new Set(chainsSetting.split(",").map((s) => s.trim().toLowerCase()));
  return CHAINS.filter((chain) => wanted.has(chain) && settles(chain, network));
}

/** "devnet" from "Solana devnet", "Sepolia" from "Base Sepolia"; "" on mainnet, where the names match. */
function networkSuffix(chain: Chain, networkName: string): string {
  const label = chainLabel(chain);
  return networkName.startsWith(label) ? networkName.slice(label.length).trim() : networkName;
}

/** Every chain the operator knows, with what it is doing on this network right now. */
export function chainStatuses(chainsSetting: string, network: Network): ChainStatus[] {
  const on = new Set(enabledChains(chainsSetting, network));
  return CHAINS.map((chain) => {
    const entry = REGISTRY[chain][network];
    const name = entry?.network ?? chainLabel(chain);
    const state: ChainState = on.has(chain) ? "live" : settles(chain, network) ? "wired" : "building";
    const suffix = networkSuffix(chain, name);
    const label =
      state === "building" ? "Building" : `${state === "live" ? "Live" : "Wired"}${suffix ? ` · ${suffix}` : ""}`;
    return { chain, state, network: name, label };
  });
}

/** The names of the chains settling now, e.g. ["Solana", "Tempo"], for share cards and one-line copy. */
export function liveChainNames(statuses: ChainStatus[]): string[] {
  return statuses.filter((s) => s.state === "live").map((s) => chainLabel(s.chain));
}

/** "a", "a and b", "a, b and c". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

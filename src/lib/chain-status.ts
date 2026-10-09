import { type Chain, CHAINS, chainLabel } from "@/lib/chains";
import { type Network, REGISTRY } from "@/lib/settlement/registry";

/**
 * "live": switched on by CHAINS and at least one payment has moved on it (settled, escrowed or refunded).
 * "ready": switched on, but no payment has moved on it yet. "wired": the registry has a stablecoin for it,
 * but CHAINS leaves it off. "building": no stablecoin or no adapter on this network yet, or (Zcash) no
 * real round-trip yet.
 */
export type ChainState = "live" | "ready" | "wired" | "building";

export type ChainStatus = {
  chain: Chain;
  state: ChainState;
  /** "Solana devnet", "Tempo Moderato"; the chain's own name where the registry has no entry. */
  network: string;
  /** "Live · devnet", "Ready · Sepolia", "Wired · Sepolia", "Building". */
  label: string;
};

/** True when the registry can settle this chain on this network: an entry, and a stablecoin for it (or, on Zcash, a demo rate for its own coin). */
function settles(chain: Chain, network: Network): boolean {
  const entry = REGISTRY[chain][network];
  if (entry === null) return false;
  if (entry.kind === "solana") return true;
  if (entry.kind === "zcash") return entry.usdPerZec !== null;
  return entry.token !== null;
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

const WORD: Record<ChainState, string> = { live: "Live", ready: "Ready", wired: "Wired", building: "Building" };

/**
 * Every chain the operator knows, with what it is doing on this network right now. `moved` is the chains
 * a payment has actually moved on (from the ledger): a chain is only "live" once one has. Pass an empty
 * set where the ledger can't be read, so nothing is called live on a guess.
 */
export function chainStatuses(chainsSetting: string, network: Network, moved: ReadonlySet<Chain>): ChainStatus[] {
  const on = new Set(enabledChains(chainsSetting, network));
  return CHAINS.map((chain) => {
    const entry = REGISTRY[chain][network];
    const name = entry?.network ?? chainLabel(chain);
    const state: ChainState = on.has(chain)
      ? moved.has(chain)
        ? "live"
        : "ready"
      : settles(chain, network) && !(entry?.kind === "zcash" && !entry.proven)
        ? "wired"
        : "building";
    const suffix = state === "building" ? "" : networkSuffix(chain, name);
    return { chain, state, network: name, label: `${WORD[state]}${suffix ? ` · ${suffix}` : ""}` };
  });
}

/** The chains switched on (live or ready), e.g. ["Solana", "Tempo"]: neutral lists that claim nothing settled. */
export function enabledChainNames(statuses: ChainStatus[]): string[] {
  return statuses.filter((s) => s.state === "live" || s.state === "ready").map((s) => chainLabel(s.chain));
}

/** "a", "a and b", "a, b and c". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

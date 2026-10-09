import { activeChains } from "@/lib/settlement";
import type { SolanaNetwork } from "@/lib/settlement/registry";
import { type ActionChainReader, solanaChainReader } from "./rpc";

/** Solana as the registry and env have it now (mint, network, RPC), or null when Solana is off. */
export function solanaActionChain(): { entry: SolanaNetwork; reader: ActionChainReader } | null {
  const active = activeChains().find((c) => c.chain === "solana");
  if (!active || active.entry.kind !== "solana") return null;
  return { entry: active.entry, reader: solanaChainReader(active.rpc.url) };
}

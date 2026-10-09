import type { Address, Hex } from "viem";
import { enabledChains } from "@/lib/chain-status";
import type { Chain } from "@/lib/chains";
import { type Env, env, escrowContractOverrides, rpcOverrides } from "@/lib/env";
import { b64ToBytes } from "@/lib/secretbox";
import { createEvmAdapter } from "./evm";
import { type EvmNetwork, type NetworkEntry, REGISTRY, type RpcSource, resolveRpc, type SolanaNetwork } from "./registry";
import { createSolanaAdapter } from "./solana";
import { createTempoAdapter } from "./tempo";
import { type Adapters, guardAdapter, type SettlementAdapter } from "./types";

/** What runs for one chain: its registry entry and the RPC it resolved to. */
export type ActiveChain = { chain: Chain; entry: NetworkEntry; rpc: { url: string; source: RpcSource } };

/** The chains listed in CHAINS that have a registry entry and a stablecoin on the selected network. */
export function activeChains(e: Env = env(), overrides: Record<string, string> = rpcOverrides()): ActiveChain[] {
  return enabledChains(e.CHAINS, e.NETWORK).flatMap((chain) => {
    const entry = REGISTRY[chain][e.NETWORK];
    if (!entry) return [];
    return [{ chain, entry, rpc: resolveRpc(entry, { alchemyKey: e.ALCHEMY_API_KEY, overrides }) }];
  });
}

/** The escrow program Solana sends use: only with the flag on, a program on this network, and the attestor key. */
export function solanaEscrow(
  e: Pick<Env, "ESCROW_PROGRAM" | "SOLANA_ESCROW_ATTESTOR_SEED">,
  entry: SolanaNetwork,
): { programId: string; attestorSeed: Uint8Array<ArrayBuffer> } | undefined {
  if (e.ESCROW_PROGRAM !== "on" || !entry.escrowProgram || !e.SOLANA_ESCROW_ATTESTOR_SEED) return undefined;
  return { programId: entry.escrowProgram, attestorSeed: b64ToBytes(e.SOLANA_ESCROW_ATTESTOR_SEED) };
}

/**
 * The escrow contract an EVM chain's sends use: only with the flag on, a contract for this deployment
 * (ESCROW_CONTRACT_<id>, else the registry's), and the attestor key.
 */
export function evmEscrow(
  e: Pick<Env, "ESCROW_PROGRAM" | "EVM_ESCROW_ATTESTOR_KEY">,
  entry: EvmNetwork,
  contracts: Record<string, string> = escrowContractOverrides(),
): { contract: Address; attestorKey: Hex } | undefined {
  const contract = contracts[`ESCROW_CONTRACT_${entry.id}`] ?? entry.escrowContract;
  if (e.ESCROW_PROGRAM !== "on" || !contract || !e.EVM_ESCROW_ATTESTOR_KEY) return undefined;
  return { contract: contract as Address, attestorKey: e.EVM_ESCROW_ATTESTOR_KEY as Hex };
}

function build(e: Env, { chain, entry, rpc }: ActiveChain): SettlementAdapter | null {
  switch (entry.kind) {
    case "solana":
      return createSolanaAdapter({
        rpcUrl: rpc.url,
        mint: entry.mint,
        explorerTx: entry.explorerTx,
        treasurySeed: b64ToBytes(e.SOLANA_TREASURY_SEED),
        escrow: solanaEscrow(e, entry),
      });
    case "tempo":
      if (!e.TEMPO_TREASURY_KEY || !entry.token) return null;
      return createTempoAdapter({
        treasuryKey: e.TEMPO_TREASURY_KEY as Hex,
        rpcUrl: rpc.url,
        token: entry.token,
        viem: entry.viem,
        explorerTx: entry.explorerTx,
        faucet: entry.faucet,
      });
    case "evm":
      if (!e.EVM_TREASURY_KEY) return null;
      return createEvmAdapter({ ...entry, chain, rpcUrl: rpc.url, treasuryKey: e.EVM_TREASURY_KEY as Hex, escrow: evmEscrow(e, entry) });
  }
}

let cached: Adapters | undefined;

export function getAdapters(): Adapters {
  if (cached) return cached;
  const e = env();
  const adapters: Adapters = {};
  for (const active of activeChains(e)) {
    const adapter = build(e, active);
    if (adapter) adapters[active.chain] = guardAdapter(adapter);
  }
  cached = adapters;
  return cached;
}

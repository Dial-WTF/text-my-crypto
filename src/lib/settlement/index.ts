import type { Hex } from "viem";
import { env } from "@/lib/env";
import { b64ToBytes } from "@/lib/secretbox";
import { createEvmAdapter } from "./evm";
import { EVM_CHAINS, type EvmChainConfig } from "./evm-chains";
import { createSolanaAdapter } from "./solana";
import type { Adapters } from "./types";

let cached: Adapters | undefined;

function enabledEvmChains(list: string): EvmChainConfig[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is EvmChainConfig["chain"] => s in EVM_CHAINS)
    .map((id) => EVM_CHAINS[id])
    .filter((c) => c.token !== null);
}

export function getAdapters(): Adapters {
  if (cached) return cached;
  const e = env();
  const adapters: Adapters = {
    solana: createSolanaAdapter({
      rpcUrl: e.SOLANA_RPC_URL,
      mint: e.SOLANA_USDC_MINT,
      treasurySeed: b64ToBytes(e.SOLANA_TREASURY_SEED),
    }),
  };
  if (e.EVM_TREASURY_KEY) {
    for (const cfg of enabledEvmChains(e.EVM_CHAINS)) {
      adapters[cfg.chain] = createEvmAdapter({ ...cfg, treasuryKey: e.EVM_TREASURY_KEY as Hex });
    }
  }
  cached = adapters;
  return adapters;
}

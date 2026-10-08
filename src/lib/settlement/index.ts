import { env } from "@/lib/env";
import { b64ToBytes } from "@/lib/secretbox";
import { createSolanaAdapter } from "./solana";
import type { Adapters } from "./types";

let cached: Adapters | undefined;

export function getAdapters(): Adapters {
  const e = env();
  cached ??= {
    solana: createSolanaAdapter({
      rpcUrl: e.SOLANA_RPC_URL,
      mint: e.SOLANA_USDC_MINT,
      treasurySeed: b64ToBytes(e.SOLANA_TREASURY_SEED),
    }),
  };
  return cached;
}

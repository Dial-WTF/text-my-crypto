import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapters } from "@/lib/settlement/types";

/**
 * getAdapters() reads env() once and caches the adapters it built for the life of the module, so every
 * test loads fresh copies of the settlement and env modules with the variables it wants.
 */

const SEED = Buffer.alloc(32, 7).toString("base64");

/** What every deployment has: enough for env() to parse, and Solana's treasury. */
const BASE_ENV = {
  APP_URL: "https://dial.example",
  DIAL_OPERATOR_NUMBER: "+15550100000",
  SMS_WEBHOOK_SECRET: "s".repeat(32),
  WALLET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  NETWORK: "testnet",
  SOLANA_TREASURY_SEED: SEED,
};

/** Keys that switch chains on. Blank counts as unset in env(), so a key in the shell can't leak in. */
const CHAIN_KEYS = ["EVM_TREASURY_KEY", "TEMPO_TREASURY_KEY", "ZCASH_SERVICE_URL", "ZCASH_SERVICE_TOKEN", "ESCROW_PROGRAM", "ALCHEMY_API_KEY"];

async function loadAdapters(vars: Record<string, string>): Promise<{ getAdapters: () => Adapters }> {
  for (const key of CHAIN_KEYS) vi.stubEnv(key, "");
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...vars })) vi.stubEnv(key, value);
  vi.resetModules();
  return import("@/lib/settlement");
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Each test re-imports the whole settlement graph (Solana kit, viem); under a full parallel run that is slow.
describe("getAdapters", { timeout: 30_000 }, () => {
  it("leaves a listed chain off when its treasury key or service is missing, instead of failing the rest", async () => {
    const { getAdapters } = await loadAdapters({ CHAINS: "solana,tempo,base,zcash" });
    expect(Object.keys(getAdapters())).toEqual(["solana"]);
  });

  it("leaves Zcash off with a service URL but no token", async () => {
    const { getAdapters } = await loadAdapters({ CHAINS: "zcash", ZCASH_SERVICE_URL: "https://zcash-wallet.example" });
    expect(getAdapters()).toEqual({});
  });

  it("builds every listed chain that has its keys, and only those listed", async () => {
    const { getAdapters } = await loadAdapters({
      CHAINS: "solana,tempo,base,zcash",
      EVM_TREASURY_KEY: `0x${"11".repeat(32)}`,
      TEMPO_TREASURY_KEY: `0x${"22".repeat(32)}`,
      ZCASH_SERVICE_URL: "https://zcash-wallet.example",
      ZCASH_SERVICE_TOKEN: "t".repeat(32),
    });
    const adapters = getAdapters();
    expect(Object.keys(adapters)).toEqual(["solana", "tempo", "base", "zcash"]);
    for (const [chain, adapter] of Object.entries(adapters)) expect(adapter.chain).toBe(chain);
    expect(adapters.ethereum).toBeUndefined();
  });

  it("builds once: later calls get the same adapters even if the environment changes", async () => {
    const { getAdapters } = await loadAdapters({ CHAINS: "solana" });
    const first = getAdapters();
    vi.stubEnv("CHAINS", "solana,tempo");
    vi.stubEnv("TEMPO_TREASURY_KEY", `0x${"22".repeat(32)}`);
    expect(getAdapters()).toBe(first);
    expect(Object.keys(getAdapters())).toEqual(["solana"]);
  });

  it("guards what it builds, so a service that doesn't answer reads as the chain being down, with no secrets", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED https://zcash-wallet.example/v1/balance?token=s3cret")));
    vi.stubGlobal("fetch", fetch);
    const { getAdapters } = await loadAdapters({
      CHAINS: "zcash",
      ZCASH_SERVICE_URL: "https://zcash-wallet.example",
      ZCASH_SERVICE_TOKEN: "t".repeat(32),
    });
    const { ChainDownError } = await import("@/lib/settlement/types");
    const zcash = getAdapters().zcash;
    if (!zcash) throw new Error("zcash adapter missing");

    const err: unknown = await zcash.getBalance("utest1x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainDownError);
    expect(err).toMatchObject({ chain: "zcash" });
    expect(String(err)).toContain("zcash RPC unavailable");
    expect(String(err)).not.toContain("s3cret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

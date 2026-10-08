import { describe, expect, it } from "vitest";
import type { Env } from "@/lib/env";
import { rpcOverrides } from "@/lib/env";
import { activeChains } from "@/lib/settlement";
import { NETWORKS, REGISTRY, RPC_OVERRIDE_KEYS, resolveRpc } from "@/lib/settlement/registry";

const solanaDevnet = REGISTRY.solana.testnet!;

const env = (over: Partial<Env>): Env => ({ NETWORK: "testnet", CHAINS: "solana,tempo", ...over }) as Env;

describe("resolveRpc", () => {
  it("prefers the network's own override, then Alchemy, then the public RPC", () => {
    const override = "https://devnet.helius-rpc.com/?api-key=k";
    expect(resolveRpc(solanaDevnet, { alchemyKey: "a", overrides: { RPC_SOLANA_DEVNET: override } })).toEqual({
      url: override,
      source: "override",
    });
    expect(resolveRpc(solanaDevnet, { alchemyKey: "a", overrides: {} })).toEqual({
      url: "https://solana-devnet.g.alchemy.com/v2/a",
      source: "alchemy",
    });
    expect(resolveRpc(solanaDevnet, { overrides: {} })).toEqual({ url: solanaDevnet.publicRpc, source: "public" });
  });

  it("falls back to the public RPC on networks Alchemy doesn't serve", () => {
    const robinhoodMainnet = REGISTRY.robinhood.mainnet!;
    expect(resolveRpc(robinhoodMainnet, { alchemyKey: "a", overrides: {} }).source).toBe("public");
  });
});

describe("registry", () => {
  it("gives every network a unique override name", () => {
    expect(new Set(RPC_OVERRIDE_KEYS).size).toBe(RPC_OVERRIDE_KEYS.length);
    expect(RPC_OVERRIDE_KEYS).toContain("RPC_SOLANA_DEVNET");
  });

  it("never points a testnet at a mainnet chain id", () => {
    for (const byNetwork of Object.values(REGISTRY)) {
      for (const network of NETWORKS) {
        const entry = byNetwork[network];
        if (!entry || entry.kind === "solana") continue;
        expect(entry.viem.testnet ?? false).toBe(network === "testnet");
      }
    }
  });
});

describe("activeChains", () => {
  it("runs only listed chains that have a stablecoin on the selected network", () => {
    const chains = activeChains(env({ CHAINS: "solana,base,robinhood,zcash" }), {});
    expect(chains.map((c) => c.chain)).toEqual(["solana", "base"]);
  });

  it("switches every chain to its mainnet entry together", () => {
    const [solana] = activeChains(env({ NETWORK: "mainnet", CHAINS: "solana" }), {});
    expect(solana?.entry.id).toBe("SOLANA_MAINNET");
  });
});

describe("rpcOverrides", () => {
  it("collects RPC_* urls, skips blanks, rejects junk", () => {
    expect(rpcOverrides({ RPC_SOLANA_DEVNET: "https://x.example", RPC_BASE_SEPOLIA: "", OTHER: "y" })).toEqual({
      RPC_SOLANA_DEVNET: "https://x.example",
    });
    expect(() => rpcOverrides({ RPC_SOLANA_DEVNET: "not a url" })).toThrow();
  });
});

describe("redactUrls", () => {
  it("keeps the host and drops paths and queries that carry keys", async () => {
    const { redactUrls } = await import("@/lib/settlement/types");
    const msg =
      'HTTP request failed.\n\nURL: https://tempo-moderato.g.alchemy.com/v2/SECRETKEY\nRequest body: {"x":1} and https://devnet.helius-rpc.com/?api-key=SECRET2';
    const out = redactUrls(msg);
    expect(out).not.toContain("SECRET");
    expect(out).toContain("tempo-moderato.g.alchemy.com/…");
    expect(out).toContain("devnet.helius-rpc.com/…");
  });
});

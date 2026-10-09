import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { Env } from "@/lib/env";
import { escrowContractOverrides, rpcOverrides } from "@/lib/env";
import { activeChains, evmEscrow, solanaEscrow } from "@/lib/settlement";
import { createEvmAdapter } from "@/lib/settlement/evm";
import { createSolanaAdapter } from "@/lib/settlement/solana";
import { findEscrowAddress, findVaultAddress, intentIdHash } from "@/lib/settlement/solana-escrow";
import { ESCROW_CONTRACT_KEYS, type EvmNetwork, NETWORKS, REGISTRY, RPC_OVERRIDE_KEYS, resolveRpc, type SolanaNetwork } from "@/lib/settlement/registry";

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
        if (!entry || entry.kind === "solana" || entry.kind === "zcash") continue;
        expect(entry.viem.testnet ?? false).toBe(network === "testnet");
      }
    }
  });
});

describe("activeChains", () => {
  it("runs only listed chains that have something to settle in on the selected network", () => {
    const chains = activeChains(env({ CHAINS: "solana,base,robinhood,zcash" }), {});
    expect(chains.map((c) => c.chain)).toEqual(["solana", "base", "robinhood", "zcash"]);
  });

  it("keeps Zcash off mainnet until it has a price and custody story", () => {
    const chains = activeChains(env({ NETWORK: "mainnet", ALLOW_MAINNET: "yes", CHAINS: "zcash" }), {});
    expect(chains).toEqual([]);
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

  it("reads only the registry's names, trims values and treats blanks as unset", () => {
    expect(
      rpcOverrides({
        RPC_SOLANA_DEVNET: "  https://x.example  ",
        RPC_BASE_SEPOLIA: "   ",
        RPC_TIMEOUT_MS: "3000",
        RPC_SOMETHING_ELSE: "not a url",
      }),
    ).toEqual({ RPC_SOLANA_DEVNET: "https://x.example" });
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

  it("drops user:pass@ in front of the host", async () => {
    const { redactUrls, errorText } = await import("@/lib/settlement/types");
    expect(redactUrls("fetch https://user:SECRET@rpc.example:8545/path?k=1 failed")).toBe("fetch rpc.example:8545/… failed");
    expect(redactUrls("ws wss://SECRET@ws.example failed")).toBe("ws ws.example/… failed");
    expect(errorText(new Error("at https://a:b@c@host.example/x"))).toBe("at host.example/…");
  });
});

describe("solana escrow program", () => {
  const seed = Buffer.alloc(32, 7).toString("base64");

  it("is used only with the flag on, a program on the network, and an attestor key", () => {
    const devnet = REGISTRY.solana.testnet as SolanaNetwork;
    const mainnet = REGISTRY.solana.mainnet as SolanaNetwork;
    const on = { ESCROW_PROGRAM: "on" as const, SOLANA_ESCROW_ATTESTOR_SEED: seed };
    expect(solanaEscrow(on, devnet)?.programId).toBe("4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3");
    expect(solanaEscrow({ ...on, ESCROW_PROGRAM: "off" }, devnet)).toBeUndefined();
    expect(solanaEscrow({ ...on, SOLANA_ESCROW_ATTESTOR_SEED: undefined }, devnet)).toBeUndefined();
    expect(solanaEscrow(on, mainnet)).toBeUndefined();
  });

  it("gives the adapter an escrow whose vault is the program's PDA for the intent", async () => {
    const adapter = createSolanaAdapter({
      rpcUrl: "http://127.0.0.1:1",
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      explorerTx: (s) => s,
      treasurySeed: new Uint8Array(32),
      escrow: { programId: "4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3", attestorSeed: new Uint8Array(32).fill(1) },
    });
    const program = address("4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3");
    const escrow = await findEscrowAddress(program, await intentIdHash("pi_abc"));
    expect(await adapter.escrow?.vaultAddress("pi_abc")).toBe(await findVaultAddress(program, escrow));

    const plain = createSolanaAdapter({ rpcUrl: "http://127.0.0.1:1", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", explorerTx: (s) => s, treasurySeed: new Uint8Array(32) });
    expect(plain.escrow).toBeUndefined();
  });
});

describe("evm escrow contract", () => {
  const arbSepolia = REGISTRY.arbitrum.testnet as EvmNetwork;
  const key = `0x${"11".repeat(32)}`;
  const contract = "0x00000000000000000000000000000000000e5c00";
  const on = { ESCROW_PROGRAM: "on" as const, EVM_ESCROW_ATTESTOR_KEY: key };

  it("has a registry field on Arbitrum Sepolia, empty until the contract is deployed", () => {
    expect(arbSepolia.escrowContract).toBeNull();
    expect(ESCROW_CONTRACT_KEYS).toEqual(["ESCROW_CONTRACT_ARBITRUM_SEPOLIA"]);
    expect(evmEscrow(on, arbSepolia, {})).toBeUndefined();
  });

  it("is used only with the flag on, a contract for this deployment, and an attestor key", () => {
    const deployed = { ...arbSepolia, escrowContract: contract } as EvmNetwork;
    expect(evmEscrow(on, deployed, {})).toEqual({ contract, attestorKey: key });
    expect(evmEscrow({ ...on, ESCROW_PROGRAM: "off" }, deployed, {})).toBeUndefined();
    expect(evmEscrow({ ...on, EVM_ESCROW_ATTESTOR_KEY: undefined }, deployed, {})).toBeUndefined();
  });

  it("lets a deployment name its own contract (staging has its own attestor)", () => {
    const staging = "0x0000000000000000000000000000000000057a6e";
    const overrides = escrowContractOverrides({ ESCROW_CONTRACT_ARBITRUM_SEPOLIA: staging, ESCROW_CONTRACT_NOPE: contract });
    expect(overrides).toEqual({ ESCROW_CONTRACT_ARBITRUM_SEPOLIA: staging });
    expect(evmEscrow(on, arbSepolia, overrides)?.contract).toBe(staging);
    expect(() => escrowContractOverrides({ ESCROW_CONTRACT_ARBITRUM_SEPOLIA: "not-an-address" })).toThrow();
  });

  it("gives the arbitrum adapter an escrow module only when a contract is set", () => {
    const base = { ...arbSepolia, chain: "arbitrum" as const, rpcUrl: "http://127.0.0.1:1", treasuryKey: key as `0x${string}` };
    expect(createEvmAdapter(base).escrow).toBeUndefined();
    const adapter = createEvmAdapter({ ...base, escrow: { contract, attestorKey: key as `0x${string}` } });
    expect(adapter.escrow?.programId).toBe(contract);
  });
});

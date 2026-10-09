import { describe, expect, it } from "vitest";
import { basenames, ensNames, evmNameService, isEvmName, normalizeName, wrongNetworkBasename } from "@/lib/evm-names";
import { parseCommand } from "@/lib/operator/grammar";
import { shortAddress, withdrawTarget } from "@/lib/payment-labels";
import { nameServiceFor } from "@/lib/settlement/capabilities";
import { type EvmNetwork, REGISTRY } from "@/lib/settlement/registry";

const entry = (chain: "ethereum" | "base") => REGISTRY[chain].testnet as EvmNetwork;

describe("names", () => {
  it.each([
    ["vitalik.eth", true],
    ["jesse.base.eth", true],
    ["pay.alice.basetest.eth", true],
    ["Vitalik.ETH", true],
    ["eth", false],
    [".eth", false],
    ["vitalik.com", false],
    ["0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb", false],
  ])("%s is a name: %s", (s, yes) => {
    expect(isEvmName(s)).toBe(yes);
  });

  it("normalizes names and turns down ones that can't exist", () => {
    expect(normalizeName("Vitalik.ETH")).toBe("vitalik.eth");
    expect(normalizeName("bad..eth")).toBeNull();
  });

  it("routes Basenames to Base and other .eth names to Ethereum", () => {
    const rpc = (chain: "ethereum" | "base") => ({ viem: entry(chain).viem, rpcUrl: entry(chain).publicRpc });
    const adapters = {
      ethereum: { names: evmNameService("ethereum", "testnet", rpc("ethereum")) },
      base: { names: evmNameService("base", "testnet", rpc("base")) },
      solana: { names: evmNameService("solana", "testnet", rpc("ethereum")) },
    };
    expect(adapters.solana.names).toBeUndefined();
    expect(nameServiceFor(adapters, "jesse.base.eth")?.chain).toBe("base");
    expect(nameServiceFor(adapters, "alice.basetest.eth")?.chain).toBe("base");
    expect(nameServiceFor(adapters, "vitalik.eth")?.chain).toBe("ethereum");
    expect(nameServiceFor(adapters, "base.eth")?.chain).toBe("ethereum");
  });

  it("knows base.eth names don't exist on testnet", () => {
    expect(wrongNetworkBasename("jesse.base.eth", "testnet")).toBe(true);
    expect(wrongNetworkBasename("jesse.basetest.eth", "testnet")).toBe(false);
    expect(wrongNetworkBasename("jesse.base.eth", "mainnet")).toBe(false);
    expect(wrongNetworkBasename("vitalik.eth", "testnet")).toBe(false);
  });

  it("labels a withdrawal by name and short address", () => {
    expect(shortAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe("0xd8dA…6045");
    expect(shortAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe("7xKX…gAsU");
    const recipientAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    expect(withdrawTarget({ recipientAddress, recipientName: "vitalik.eth" })).toBe("vitalik.eth (0xd8dA…6045)");
    expect(withdrawTarget({ recipientAddress, recipientName: null })).toBe("0xd8dA…6045");
  });
});

describe("parseCommand: withdraw to a name", () => {
  it.each([
    ["withdraw all to vitalik.eth", { kind: "withdraw", amountUsd: "all", address: "vitalik.eth" }],
    ["withdraw $5 to jesse.base.eth", { kind: "withdraw", amountUsd: "5", address: "jesse.base.eth" }],
    ["send $5 to Vitalik.eth.", { kind: "withdraw", amountUsd: "5", address: "Vitalik.eth" }],
    ["cash out 10 to alice.basetest.eth on ethereum", { kind: "withdraw", amountUsd: "10", address: "alice.basetest.eth", chain: "ethereum" }],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it("still reads a plain name as a person", () => {
    expect(parseCommand("send $5 to vitalik")).toEqual({ kind: "send", counterparty: "vitalik", amountUsd: "5" });
  });
});

// Live lookups on Sepolia and Base Sepolia (read-only, no keys needed): NAMES_INT=1 pnpm vitest run tests/evm-names.test.ts
describe.runIf(process.env.NAMES_INT === "1")("name resolver (testnets, live)", () => {
  const ens = ensNames({ viem: entry("ethereum").viem, rpcUrl: entry("ethereum").publicRpc });
  const base = basenames("testnet", { viem: entry("base").viem, rpcUrl: entry("base").publicRpc });

  it("resolves an ENS name on Sepolia", { timeout: 30_000 }, async () => {
    expect(await ens.resolve("Vitalik.eth")).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });

  it("resolves a Basename on Base Sepolia", { timeout: 30_000 }, async () => {
    expect(await base.resolve("alice.basetest.eth")).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("finds nothing for a name nobody registered", { timeout: 30_000 }, async () => {
    expect(await base.resolve("jesse.base.eth")).toBeNull();
    expect(await ens.resolve("dial-no-such-name-0x1.eth")).toBeNull();
  });
});

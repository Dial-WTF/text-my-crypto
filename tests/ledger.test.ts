import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/lib/env";
import { chainProofs, networkName, safeNetworkName } from "@/lib/ledger";
import { activeChains } from "@/lib/settlement";
import { fakeAdapter } from "./helpers/fakes";

vi.mock("@/lib/db/client", () => ({
  getDb: () => {
    throw new Error("D1 unreachable at https://admin:hunter2@d1.example/v1/db");
  },
}));

const testnet = (chains: string) => activeChains({ NETWORK: "testnet", CHAINS: chains } as Env, {});

afterEach(() => vi.restoreAllMocks());

describe("chainProofs", () => {
  it("asks each chain on its own and keeps the ones that answer", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = { ...fakeAdapter({ chain: "base" }), treasuryAddress: () => Promise.reject(new Error("rpc down")) };
    const proofs = await chainProofs({ solana: fakeAdapter(), base: down }, testnet("solana,base"));
    expect(proofs).toEqual([
      expect.objectContaining({ chain: "solana", network: "Solana devnet", treasury: "solanaTreasury" }),
    ]);
    expect(errors).toHaveBeenCalledWith("chain proof unavailable", "base", "rpc down");
  });

  it("skips chains with no adapter", async () => {
    expect(await chainProofs({}, testnet("solana"))).toEqual([]);
  });
});

describe("network names", () => {
  it("names the network for a chain, and falls back to the chain when env is unreadable", () => {
    expect(networkName("solana", "testnet")).toBe("Solana devnet");
    expect(networkName("base", "mainnet")).toBe("Base");
    // No env in tests: env() would throw here.
    expect(safeNetworkName("solana")).toBe("Solana");
  });
});

describe("/ledger.json", () => {
  it("still answers, with empty parts, when the database, env and chains are all down", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/ledger.json/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ network: null, stats: null, treasuries: [], escrowPrograms: [], payments: [] });
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("d1.example/…");
    expect(logged).not.toContain("hunter2");
  });
});

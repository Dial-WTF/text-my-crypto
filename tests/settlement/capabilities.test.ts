import { describe, expect, it } from "vitest";
import { chainWith, FEATURES, featuresOf, type NameService, nameServiceFor } from "@/lib/settlement/capabilities";
import type { Adapters, EscrowProgram } from "@/lib/settlement/types";
import { fakeAdapter } from "../helpers/fakes";

const names = (suffix: string, address: string): NameService => ({
  suffixes: [suffix],
  resolve: async () => address,
});

const escrow = { programId: "Escrow111" } as EscrowProgram;

describe("chain capabilities", () => {
  it("lists the modules an adapter carries, and every module has plain words", () => {
    const plain = fakeAdapter({ chain: "tempo" });
    expect(featuresOf(plain)).toEqual([]);
    expect(featuresOf({ ...fakeAdapter({ chain: "solana" }), escrow })).toEqual(["escrow"]);
    for (const f of Object.values(FEATURES)) {
      expect(f.title).not.toMatch(/live|first|only/i);
      expect(f.summary.length).toBeLessThan(80);
    }
  });

  it("picks the preferred chain when it carries the module, else the first one that does", () => {
    const batch = { maxLegs: 10, settleBatch: async () => ({ txHash: "0x1", explorerUrl: "x" }) };
    const adapters: Adapters = {
      solana: fakeAdapter({ chain: "solana" }),
      tempo: { ...fakeAdapter({ chain: "tempo" }), batch },
    };
    expect(chainWith(adapters, "batch", "solana")?.chain).toBe("tempo");
    expect(chainWith(adapters, "batch", "tempo")?.module.maxLegs).toBe(10);
    expect(chainWith(adapters, "shielded")).toBeNull();
  });

  it("routes a name to the service with the longest matching ending", () => {
    const adapters: Adapters = {
      ethereum: { ...fakeAdapter({ chain: "ethereum" }), names: names(".eth", "0xE") },
      base: { ...fakeAdapter({ chain: "base" }), names: names(".base.eth", "0xB") },
    };
    expect(nameServiceFor(adapters, "jesse.base.eth")?.chain).toBe("base");
    expect(nameServiceFor(adapters, "Vitalik.ETH")?.chain).toBe("ethereum");
    expect(nameServiceFor(adapters, ".eth")).toBeNull();
    expect(nameServiceFor(adapters, "alex")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { chainLabel, parseChain } from "@/lib/chains";

describe("chains", () => {
  it("parses names and aliases", () => {
    expect(parseChain("SOL")).toBe("solana");
    expect(parseChain("solana")).toBe("solana");
    expect(parseChain("zec")).toBe("zcash");
    expect(parseChain("tempo")).toBe("tempo");
    expect(parseChain("base")).toBe("base");
    expect(parseChain("arb")).toBe("arbitrum");
    expect(parseChain("Hyperliquid")).toBe("hyperevm");
    expect(parseChain("eth")).toBe("ethereum");
    expect(parseChain("hood")).toBe("robinhood");
    expect(parseChain("dogecoin")).toBeNull();
  });

  it("labels chains", () => {
    expect(chainLabel("solana")).toBe("Solana");
  });
});

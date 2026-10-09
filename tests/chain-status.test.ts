import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainsSentence, limitItems, settlesOn } from "@/app/landing-content";
import { chainStatuses, enabledChains, listWords, liveChainNames } from "@/lib/chain-status";
import type { Env } from "@/lib/env";
import { activeChains } from "@/lib/settlement";

const PRODUCTION = "solana,tempo,ethereum,robinhood";

/** wrangler.jsonc's production vars. Comments there sit on their own lines. */
function wranglerVars(): Record<string, string> {
  const jsonc = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  return (JSON.parse(jsonc) as { vars: Record<string, string> }).vars;
}

const byChain = (chains: string, network: "testnet" | "mainnet" = "testnet") =>
  Object.fromEntries(chainStatuses(chains, network).map((s) => [s.chain, s.label]));

describe("chainStatuses", () => {
  it("marks production's chains live, registry chains with a token wired, zcash building", () => {
    expect(byChain(PRODUCTION)).toEqual({
      solana: "Live · devnet",
      tempo: "Live · Moderato",
      ethereum: "Live · Sepolia",
      robinhood: "Live · testnet",
      base: "Wired · Sepolia",
      arbitrum: "Wired · Sepolia",
      hyperevm: "Wired · testnet",
      zcash: "Building",
    });
  });

  it("follows the CHAINS default when nothing else is switched on", () => {
    const s = byChain("solana,tempo");
    expect([s.solana, s.tempo, s.ethereum, s.robinhood]).toEqual(["Live · devnet", "Live · Moderato", "Wired · Sepolia", "Wired · testnet"]);
  });

  it("never calls a chain live without a stablecoin on the network, whatever CHAINS says", () => {
    expect(enabledChains("solana, Tempo ,zcash,dogecoin", "testnet")).toEqual(["solana", "tempo"]);
    // Tempo and HyperEVM mainnet have no settlement token yet; Robinhood mainnet has none either.
    const main = byChain("solana,tempo,hyperevm,robinhood,base", "mainnet");
    expect(main).toMatchObject({ solana: "Live", base: "Live", tempo: "Building", hyperevm: "Building", robinhood: "Building" });
    expect(main.ethereum).toBe("Wired");
  });

  it("agrees with the chains settlement actually runs", () => {
    const e = { NETWORK: "testnet", CHAINS: PRODUCTION } as Env;
    expect(activeChains(e, {}).map((c) => c.chain)).toEqual(enabledChains(PRODUCTION, "testnet"));
  });

  it("calls every chain production switches on live", () => {
    const chains = wranglerVars().CHAINS ?? "";
    const wanted = chains.split(",").map((c) => c.trim());
    expect(enabledChains(chains, "testnet")).toEqual(expect.arrayContaining(wanted));
    expect(enabledChains(chains, "testnet")).toHaveLength(wanted.length);
  });
});

describe("site copy from chain status", () => {
  const statuses = chainStatuses(PRODUCTION, "testnet");

  it("puts live tiles first, with the derived label", () => {
    const tiles = settlesOn(statuses);
    expect(tiles.map((t) => [t.name, t.status, t.statusLabel])).toEqual([
      ["Solana", "live", "Live · devnet"],
      ["Tempo", "live", "Live · Moderato"],
      ["Ethereum", "live", "Live · Sepolia"],
      ["Robinhood Chain", "live", "Live · testnet"],
      ["Base", "next", "Wired · Sepolia"],
      ["Arbitrum", "next", "Wired · Sepolia"],
      ["Hyperliquid", "next", "Wired · testnet"],
      ["Zcash", "next", "Building"],
    ]);
  });

  it("says the same thing in the colophon", () => {
    expect(chainsSentence(statuses, "testnet")).toBe(
      "Payments settle in test stablecoins on Solana devnet, Tempo Moderato, Ethereum Sepolia and Robinhood Chain testnet. " +
        "Base, Arbitrum and HyperEVM are wired but switched off. Zcash is still being built.",
    );
    expect(chainsSentence(chainStatuses("solana", "testnet"), "testnet")).toMatch(/^Payments settle in test stablecoins on Solana devnet\. /);
    expect(chainsSentence(chainStatuses("", "testnet"), "testnet")).toMatch(/^No chain is switched on right now\./);
  });

  it("names live chains for share cards", () => {
    expect(liveChainNames(statuses)).toEqual(["Solana", "Tempo", "Ethereum", "Robinhood Chain"]);
  });

  it("joins words like a person would", () => {
    expect([listWords([]), listWords(["a"]), listWords(["a", "b"]), listWords(["a", "b", "c"])]).toEqual(["", "a", "a and b", "a, b and c"]);
  });
});

describe("limitItems", () => {
  const limits = { perPaymentUsd: "50", perDayUsd: "200", passkeyAboveUsd: "20", signupDripUsd: "2", escrowDays: 7 };

  it("shows the operator's limits and the testnet drop", () => {
    expect(limitItems(limits, "testnet").map((l) => l.value)).toEqual(["$50", "$200", "Over $20", "$2", "7 days"]);
  });

  it("leaves out the drop on mainnet or when it is zero", () => {
    expect(limitItems(limits, "mainnet").map((l) => l.value)).not.toContain("$2");
    expect(limitItems({ ...limits, signupDripUsd: "0" }, "testnet")).toHaveLength(4);
  });

  it("reads production's drop from wrangler.jsonc", () => {
    const drip = wranglerVars().SIGNUP_DRIP_USD ?? "25";
    expect(limitItems({ ...limits, signupDripUsd: drip }, "testnet")[3]?.value).toBe(`$${drip}`);
  });
});

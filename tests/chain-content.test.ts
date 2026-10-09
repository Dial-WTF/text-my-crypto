import { statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ATTACHED_FEATURES,
  CHAIN_COPY,
  CHAIN_PAGES,
  codeUrl,
  mcpArgs,
  payLinkFormat,
  registryProof,
  tryText,
} from "@/app/chain-content";
import { CHAIN_SITEMAP_PAGES } from "@/app/public-pages";
import { toolInputs } from "@/lib/agents/tools";
import { CHAINS, parseChain } from "@/lib/chains";
import { resetEnvForTests } from "@/lib/env";
import { parseCommand } from "@/lib/operator/grammar";
import { getAdapters } from "@/lib/settlement";
import { FEATURES, featuresOf } from "@/lib/settlement/capabilities";
import { REGISTRY } from "@/lib/settlement/registry";

const ROOT = join(__dirname, "..");

/** Every word a chain page or its share card prints from the copy. */
const allCopy = (chain: (typeof CHAINS)[number]) => {
  const c = CHAIN_COPY[chain];
  return [
    c.name,
    c.summary,
    ...c.runs,
    c.building?.text ?? "",
    ...Object.values(c.features).flatMap((f) => [...f.detail, ...f.code.map((l) => l.label)]),
    ...c.code.map((l) => l.label),
  ].join("\n");
};

describe("chain page copy", () => {
  it("covers every chain in the registry, each with a page", () => {
    expect(Object.keys(CHAIN_COPY).sort()).toEqual([...CHAINS].sort());
    expect(CHAIN_PAGES.map((p) => p.path)).toEqual(CHAINS.map((c) => `/chains/${c}`));
    expect(CHAIN_SITEMAP_PAGES.map((p) => p.path)).toEqual(CHAIN_PAGES.map((p) => p.path));
  });

  it("gives every chain a summary, what runs (or what is being built) and code links to files on main", () => {
    for (const chain of CHAINS) {
      const c = CHAIN_COPY[chain];
      expect(c.summary.length, chain).toBeGreaterThan(20);
      expect(c.runs.length > 0 || c.building !== undefined, chain).toBe(true);
      expect(c.code.length, chain).toBeGreaterThan(0);
      const links = [...c.code, ...Object.values(c.features).flatMap((f) => f.code)];
      for (const { path, label } of links) {
        expect(label.length, `${chain}: "${label}" wraps on a phone`).toBeLessThanOrEqual(28);
        expect(statSync(join(ROOT, path), { throwIfNoEntry: false })?.isFile(), `${chain}: ${path}`).toBe(true);
        expect(codeUrl("https://github.com/Dial-WTF/text-my-crypto", path)).toBe(
          `https://github.com/Dial-WTF/text-my-crypto/blob/main/${path}`,
        );
      }
    }
  });

  it("only describes chains as running where the registry can settle them; the rest say they are being built", () => {
    for (const chain of CHAINS) {
      const settles = REGISTRY[chain].testnet !== null;
      expect(CHAIN_COPY[chain].building === undefined, chain).toBe(settles);
      if (!settles) expect(CHAIN_COPY[chain].runs, chain).toEqual([]);
    }
  });

  it("never says Live in static copy (a cached card would go stale), and follows the copy rules", () => {
    for (const chain of CHAINS) {
      const words = allCopy(chain);
      expect(words, chain).not.toMatch(/\blive\b/i);
      expect(words, chain).not.toMatch(/—|\bfirst\b|revolutionary|text my bits|\bDNN\b/i);
    }
  });

  it("gives each chain a text the operator parses as a payment on that chain", () => {
    for (const chain of CHAINS) {
      expect(parseChain(CHAIN_COPY[chain].textWord), chain).toBe(chain);
      expect(parseCommand(tryText(chain)), chain).toEqual({ kind: "send", counterparty: "@handle", amountUsd: "1", chain });
    }
  });

  it("gives each chain an MCP call the send_payment tool accepts", () => {
    for (const chain of CHAINS) {
      expect(toolInputs.send_payment.parse(mcpArgs(chain)), chain).toEqual({ to: "@handle", amountUsd: "1", chain });
    }
  });
});

describe("pay link formats", () => {
  it("are Solana Pay on Solana, EIP-681 on Tempo and EVM chains, and absent where there is no stablecoin", () => {
    expect(payLinkFormat("solana", "testnet")).toEqual({
      standard: "Solana Pay",
      example: "solana:<wallet>?amount=1&spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU&label=Dial%20%C2%B7%20%40handle",
    });
    expect(payLinkFormat("base", "testnet")).toEqual({
      standard: "EIP-681",
      example: "ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=<wallet>&uint256=1000000",
    });
    expect(payLinkFormat("tempo", "testnet")?.standard).toBe("EIP-681");
    expect(payLinkFormat("zcash", "testnet")).toEqual({
      standard: "ZIP 321",
      example: "zcash:<wallet>?amount=0.02&label=Dial%20%C2%B7%20%40handle",
    });
    expect(payLinkFormat("zcash", "mainnet")).toBeNull();
    expect(payLinkFormat("tempo", "mainnet")).toBeNull();
  });
});

describe("registry proof", () => {
  it("links the stablecoin contract and, on Solana, the escrow program, from the registry", () => {
    expect(registryProof("solana", "testnet").map((r) => [r.label, r.address])).toEqual([
      ["test USDC mint", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"],
      ["dial_escrow program", "4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3"],
    ]);
    expect(registryProof("robinhood", "testnet")).toEqual([
      {
        label: "Dial Test USD (dUSD) contract",
        address: "0x2195e3E09eab088c90B4461B92D06A74d30c1e2e",
        url: "https://explorer.testnet.chain.robinhood.com/address/0x2195e3E09eab088c90B4461B92D06A74d30c1e2e",
      },
    ]);
    expect(registryProof("zcash", "testnet")).toEqual([]);
  });
});

describe("Built for <chain>", () => {
  const saved = { ...process.env };
  afterAll(() => {
    process.env = saved;
    resetEnvForTests();
  });

  it("has detail copy for every module a chain attaches", () => {
    for (const chain of CHAINS) {
      for (const id of ATTACHED_FEATURES[chain]) {
        expect(FEATURES[id], `${chain}: ${id}`).toBeDefined();
        expect(CHAIN_COPY[chain].features[id]?.detail.length, `${chain}: ${id}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the static fallback in step with what the adapters attach when built with every key", () => {
    const seed = Buffer.alloc(32, 7).toString("base64");
    Object.assign(process.env, {
      APP_URL: "https://dial.example",
      DIAL_OPERATOR_NUMBER: "+15550100000",
      SMS_WEBHOOK_SECRET: "s".repeat(32),
      WALLET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      NETWORK: "testnet",
      CHAINS: CHAINS.join(","),
      SOLANA_TREASURY_SEED: seed,
      EVM_TREASURY_KEY: `0x${"11".repeat(32)}`,
      TEMPO_TREASURY_KEY: `0x${"22".repeat(32)}`,
      ESCROW_PROGRAM: "on",
      SOLANA_ESCROW_ATTESTOR_SEED: seed,
      ZCASH_SERVICE_URL: "https://zcash-wallet.example",
      ZCASH_SERVICE_TOKEN: "t".repeat(32),
    });
    resetEnvForTests();
    const adapters = getAdapters();
    for (const chain of CHAINS) {
      const adapter = adapters[chain];
      expect(adapter, chain).toBeDefined();
      expect(adapter ? featuresOf(adapter) : [], chain).toEqual(ATTACHED_FEATURES[chain]);
    }
  });
});

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chainsSentence, limitItems, settlesOn } from "@/app/landing-content";
import { chainStatuses, enabledChainNames, enabledChains, listWords } from "@/lib/chain-status";
import type { Chain } from "@/lib/chains";
import { intents } from "@/lib/db/schema";
import type { Env } from "@/lib/env";
import { createUser } from "@/lib/identity";
import { createIntent } from "@/lib/intents";
import { activeChains } from "@/lib/settlement";
import { movedByChain } from "@/lib/stats";
import { createTestDb } from "./helpers/db";

const PRODUCTION = "solana,tempo,ethereum,robinhood";
const NONE: ReadonlySet<Chain> = new Set();
const SOLANA_TEMPO: ReadonlySet<Chain> = new Set(["solana", "tempo"]);

/** wrangler.jsonc's production vars. Comments there sit on their own lines. */
function wranglerVars(): Record<string, string> {
  const jsonc = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  return (JSON.parse(jsonc) as { vars: Record<string, string> }).vars;
}

const labels = (chains: string, moved: ReadonlySet<Chain>, network: "testnet" | "mainnet" = "testnet") =>
  Object.fromEntries(chainStatuses(chains, network, moved).map((s) => [s.chain, s.label]));

describe("chainStatuses", () => {
  it("calls a chain live only once a payment has moved on it; switched on without one is ready", () => {
    expect(labels(PRODUCTION, SOLANA_TEMPO)).toEqual({
      solana: "Live · devnet",
      tempo: "Live · Moderato",
      ethereum: "Ready · Sepolia",
      robinhood: "Ready · testnet",
      base: "Wired · Sepolia",
      arbitrum: "Wired · Sepolia",
      hyperevm: "Wired · testnet",
      zcash: "Building",
    });
  });

  it("calls nothing live when the ledger has no payments or can't be read", () => {
    const states = chainStatuses(PRODUCTION, "testnet", NONE).map((s) => s.state);
    expect(states).not.toContain("live");
    expect(states.filter((s) => s === "ready")).toHaveLength(4);
  });

  it("never calls a chain live that CHAINS leaves off, even with payments on it", () => {
    const s = labels("solana", new Set<Chain>(["solana", "base", "zcash"]));
    expect([s.solana, s.base, s.zcash]).toEqual(["Live · devnet", "Wired · Sepolia", "Building"]);
  });

  it("only switches on chains with a stablecoin on the network, whatever CHAINS says", () => {
    expect(enabledChains("solana, Tempo ,zcash,dogecoin", "testnet")).toEqual(["solana", "tempo"]);
    // Tempo, HyperEVM and Robinhood mainnet have no settlement token yet.
    const main = labels("solana,tempo,hyperevm,robinhood,base", new Set<Chain>(["solana"]), "mainnet");
    expect(main).toMatchObject({ solana: "Live", base: "Ready", tempo: "Building", hyperevm: "Building", robinhood: "Building", ethereum: "Wired" });
  });

  it("agrees with the chains settlement actually runs", () => {
    const e = { NETWORK: "testnet", CHAINS: PRODUCTION } as Env;
    expect(activeChains(e, {}).map((c) => c.chain)).toEqual(enabledChains(PRODUCTION, "testnet"));
  });

  it("switches on every chain production lists in wrangler.jsonc", () => {
    const chains = wranglerVars().CHAINS ?? "";
    const wanted = chains.split(",").map((c) => c.trim());
    expect(enabledChains(chains, "testnet")).toEqual(expect.arrayContaining(wanted));
    expect(enabledChains(chains, "testnet")).toHaveLength(wanted.length);
  });
});

describe("movedByChain", () => {
  it("counts settled, escrowed and refunded payments per chain, not pending or failed ones", async () => {
    const db = await createTestDb();
    const now = new Date("2026-10-09T12:00:00Z");
    const a = await createUser(db, { phone: "+15550000010", handle: "alex", name: "Alex" }, now);
    const b = await createUser(db, { phone: "+15550000011", handle: "sam", name: "Sam" }, now);
    const pay = async (chain: Chain, status: (typeof intents.$inferSelect)["status"]) => {
      const i = await createIntent(
        db,
        { kind: "send", createdBy: a.id, senderId: a.id, recipientId: b.id, chain, token: "T", recipientAddress: "E", amount: 1_000_000n, note: null },
        now,
      );
      await db.update(intents).set({ status }).where(eq(intents.id, i.id));
    };
    await pay("solana", "settled");
    await pay("solana", "escrowed");
    await pay("tempo", "refunded");
    await pay("ethereum", "pending");
    await pay("robinhood", "failed");
    await pay("base", "settling");

    const moved = await movedByChain(db);
    expect(moved).toEqual({ solana: 2, tempo: 1 });
    expect(labels(PRODUCTION, new Set(Object.keys(moved) as Chain[]))).toMatchObject({
      solana: "Live · devnet",
      tempo: "Live · Moderato",
      ethereum: "Ready · Sepolia",
      robinhood: "Ready · testnet",
    });
  });
});

describe("site copy from chain status", () => {
  const statuses = chainStatuses(PRODUCTION, "testnet", SOLANA_TEMPO);

  it("orders tiles live, ready, wired, building, and only live tiles get the live style", () => {
    expect(settlesOn(statuses).map((t) => [t.name, t.status, t.statusLabel])).toEqual([
      ["Solana", "live", "Live · devnet"],
      ["Tempo", "live", "Live · Moderato"],
      ["Ethereum", "next", "Ready · Sepolia"],
      ["Robinhood Chain", "next", "Ready · testnet"],
      ["Base", "next", "Wired · Sepolia"],
      ["Arbitrum", "next", "Wired · Sepolia"],
      ["Hyperliquid", "next", "Wired · testnet"],
      ["Zcash", "next", "Building"],
    ]);
  });

  it("says in the colophon only that payments settled where they did", () => {
    expect(chainsSentence(statuses, "testnet")).toBe(
      "Payments have settled in test stablecoins on Solana devnet and Tempo Moderato. " +
        "Ethereum Sepolia and Robinhood Chain testnet are switched on, with no payment settled there yet. " +
        "Base, Arbitrum and HyperEVM are wired but switched off. Zcash is still being built.",
    );
    expect(chainsSentence(chainStatuses("solana", "testnet", NONE), "testnet")).toMatch(
      /^Solana devnet is switched on, with no payment settled there yet\. /,
    );
    expect(chainsSentence(chainStatuses("", "testnet", NONE), "testnet")).toMatch(/^No chain is switched on right now\./);
  });

  it("never says live or first", () => {
    const words = [chainsSentence(statuses, "testnet"), ...settlesOn(chainStatuses(PRODUCTION, "testnet", NONE)).map((t) => t.statusLabel)];
    for (const w of words) expect(w).not.toMatch(/\bfirst\b/i);
    expect(settlesOn(chainStatuses(PRODUCTION, "testnet", NONE)).map((t) => t.statusLabel).join(" ")).not.toMatch(/Live/);
  });

  it("lists switched-on chains neutrally for static share cards", () => {
    expect(enabledChainNames(chainStatuses(PRODUCTION, "testnet", NONE))).toEqual(["Solana", "Tempo", "Ethereum", "Robinhood Chain"]);
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

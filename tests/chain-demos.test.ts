import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { settlesOn } from "@/app/landing-content";
import { blinkFor } from "@/app/chains/_demos/ActionsDemo";
import { cleanName } from "@/app/chains/_demos/names";
import { dollars, parseRecipients, splitPreview } from "@/app/chains/_demos/split";
import { loadMids, pickMids } from "@/app/chains/_demos/venue";
import { chainStatuses } from "@/lib/chain-status";
import { createUser } from "@/lib/identity";
import { claimForSettlement, createIntent, markEscrowed, markReleased, markSettled } from "@/lib/intents";
import { FEATURES } from "@/lib/settlement/capabilities";
import { latestSplit, newestHandle, recentEscrows } from "@/lib/stats";
import { memoizer } from "@/lib/web/memo";
import { ChainStrip } from "@/ui/patterns/ChainStrip/ChainStrip";
import { createTestDb } from "./helpers/db";

vi.mock("@/lib/db/client", () => ({ getDb: () => null }));

describe("memoizer", () => {
  it("loads a key once per ttl, forgets failures, and drops the oldest key when full", async () => {
    const memo = memoizer<number>({ ttlMs: 1000, maxKeys: 2 });
    const load = vi.fn(async () => 1);
    await memo("a", load, 0);
    await memo("a", load, 500);
    expect(load).toHaveBeenCalledTimes(1);
    await memo("a", load, 1500);
    expect(load).toHaveBeenCalledTimes(2);

    await expect(memo("bad", () => Promise.reject(new Error("down")), 2000)).rejects.toThrow("down");
    await expect(memo("bad", async () => 2, 2001)).resolves.toBe(2);

    const c = vi.fn(async () => 3);
    await memo("c", c, 2002); // "a" is the oldest of a, bad, c: dropped
    await memo("a", load, 2003);
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe("split preview", () => {
  it("splits evenly to the cent, leftover cents to the first legs, and always adds up", () => {
    const p = splitPreview("10", parseRecipients("alex, @sam +15550100000"), 10);
    expect(p).toEqual({
      ok: true,
      legs: [
        { to: "@alex", cents: 334 },
        { to: "@sam", cents: 333 },
        { to: "+15550100000", cents: 333 },
      ],
    });
    expect(dollars(334)).toBe("$3.34");
  });

  it("asks for 2 to 5 different people (fewer if the chain carries fewer legs) and a real amount", () => {
    expect(splitPreview("10", ["@a"], 10).ok).toBe(false);
    expect(splitPreview("10", ["@a", "@A"], 10).ok).toBe(false);
    expect(splitPreview("10", ["@a", "@b", "@c", "@d", "@e", "@f"], 10)).toEqual({ ok: false, error: "Name 2 to 5 different people." });
    expect(splitPreview("10", ["@a", "@b", "@c"], 2)).toEqual({ ok: false, error: "Name 2 to 2 different people." });
    expect(splitPreview("ten", ["@a", "@b"], 10).ok).toBe(false);
    expect(splitPreview("0.01", ["@a", "@b"], 10).ok).toBe(false);
  });
});

describe("name lookup input", () => {
  it("accepts plain names ending in a suffix the service answers for, and nothing else", () => {
    expect(cleanName(" Jesse.Base.eth ", [".base.eth"])).toBe("jesse.base.eth");
    expect(cleanName("vitalik.eth", [".eth"])).toBe("vitalik.eth");
    expect(cleanName("vitalik.eth", [".base.eth"])).toBeNull();
    expect(cleanName(".eth", [".eth"])).toBeNull();
    expect(cleanName("a..eth", [".eth"])).toBeNull();
    expect(cleanName("-bad.eth", [".eth"])).toBeNull();
    expect(cleanName("x.eth?<script>", [".eth"])).toBeNull();
    expect(cleanName(`${"a".repeat(70)}.eth`, [".eth"])).toBeNull();
  });
});

describe("venue mids", () => {
  it("picks HYPE and BTC from Hyperliquid's allMids, and nothing odd", () => {
    expect(pickMids({ HYPE: "41.5", BTC: "61234.5", ETH: "3000" })).toEqual({ HYPE: "41.5", BTC: "61234.5" });
    expect(pickMids({ HYPE: 41.5, BTC: "<b>" })).toEqual({ HYPE: null, BTC: null });
    expect(pickMids(null)).toEqual({ HYPE: null, BTC: null });
  });

  it("asks the public info API with a POST and caches the answer", async () => {
    const fetcher = vi.fn(async () => Response.json({ HYPE: "40", BTC: "60000" }));
    expect(await loadMids("testnet", fetcher as unknown as typeof fetch)).toEqual({ HYPE: "40", BTC: "60000" });
    await loadMids("testnet", fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toMatchObject(["https://api.hyperliquid-testnet.xyz/info", { method: "POST", body: '{"type":"allMids"}' }]);
  });
});

describe("feature demos", () => {
  it("has a slot for every module, so a chain's demo appears when its module is attached", async () => {
    const { FEATURE_DEMOS } = await import("@/app/chains/_demos");
    expect(Object.keys(FEATURE_DEMOS).sort()).toEqual(Object.keys(FEATURES).sort());
  });

  it("renders nothing for a module the chain doesn't carry", async () => {
    const { FEATURE_DEMOS } = await import("@/app/chains/_demos");
    for (const demo of Object.values(FEATURE_DEMOS)) {
      // Escrow, shielded and batch demos read the ledger (or compute locally), so they render without an adapter.
      if (!demo || ["EscrowDemo", "ShieldedDemo", "BatchDemo"].includes(demo.name)) continue;
      expect(await demo({ chain: "base", network: "testnet", name: "Base", adapter: null })).toBeNull();
    }
  });
});

describe("recentEscrows", () => {
  it("lists payments that went through the escrow program on one chain, with the funding and closing transactions", async () => {
    const db = await createTestDb();
    const now = new Date("2026-10-09T12:00:00Z");
    const a = await createUser(db, { phone: "+15550000030", handle: "alex" }, now);
    const j = await createUser(db, { phone: "+15550000031", handle: "jeremy" }, now);
    const base = { kind: "send" as const, createdBy: a.id, senderId: a.id, recipientId: j.id, recipientAddress: "V", token: "M", note: null };

    const claimed = await createIntent(db, { ...base, chain: "solana", amount: 1n, escrowProgram: "Prog1" }, now);
    await claimForSettlement(db, claimed.id, now);
    await markEscrowed(db, claimed.id, { txHash: "F1", explorerUrl: "https://x/F1" }, now);
    await markReleased(db, claimed.id, "settled", { txHash: "C1", explorerUrl: "https://x/C1" }, now);

    const plain = await createIntent(db, { ...base, chain: "solana", amount: 2n }, new Date(now.getTime() + 1000));
    await claimForSettlement(db, plain.id, now);
    await markSettled(db, plain.id, { txHash: "S1", explorerUrl: "https://x/S1" }, now);

    expect(await recentEscrows(db, "solana", 5)).toEqual([
      {
        id: claimed.id,
        status: "settled",
        funded: { txHash: "F1", explorerUrl: "https://x/F1" },
        closed: { txHash: "C1", explorerUrl: "https://x/C1" },
        at: now,
      },
    ]);
    expect(await recentEscrows(db, "base", 5)).toEqual([]);
  });
});

describe("chain tiles", () => {
  it("link every tile to its chain page with a name that says where it goes", () => {
    const items = settlesOn(chainStatuses("solana,tempo", "testnet", new Set()), { branded: true });
    const html = renderToStaticMarkup(createElement(ChainStrip, { heading: "Chains", items }));
    expect(html).toContain('href="/chains/solana" aria-label="Solana: how Dial uses it"');
    expect(html).toContain('href="/chains/hyperevm" aria-label="Hyperliquid: how Dial uses it"');
    expect(html).toContain('data-brand="zcash"');
    expect(html.match(/<a /g)).toHaveLength(8);
  });
});

describe("latestSplit", () => {
  it("returns the newest split on a chain with every leg, its total and its one transaction", async () => {
    const db = await createTestDb();
    const now = new Date("2026-10-09T12:00:00Z");
    const a = await createUser(db, { phone: "+15550000040", handle: "alex" }, now);
    const b = await createUser(db, { phone: "+15550000041", handle: "sam" }, now);
    const c = await createUser(db, { phone: "+15550000042", handle: "jo" }, now);
    const leg = async (splitId: string, to: string, amount: bigint, tx: string, at: Date) => {
      const i = await createIntent(
        db,
        { kind: "send", createdBy: a.id, senderId: a.id, recipientId: to, recipientAddress: "0x", chain: "tempo", token: "T", note: null, amount, splitId },
        at,
      );
      await claimForSettlement(db, i.id, at);
      await markSettled(db, i.id, { txHash: tx, explorerUrl: `https://explore.test/tx/${tx}` }, at);
    };
    expect(await latestSplit(db, "tempo")).toBeNull();
    await leg("sp_old", b.id, 1_000_000n, "0xold", now);
    const later = new Date(now.getTime() + 60_000);
    await leg("sp_new", b.id, 3_340_000n, "0xnew", later);
    await leg("sp_new", c.id, 3_330_000n, "0xnew", later);
    expect(await latestSplit(db, "tempo")).toEqual({
      splitId: "sp_new",
      legs: [
        { to: "@sam", amount: 3_340_000n },
        { to: "@jo", amount: 3_330_000n },
      ],
      total: 6_670_000n,
      txHash: "0xnew",
      explorerUrl: "https://explore.test/tx/0xnew",
      at: later,
    });
    expect(await latestSplit(db, "solana")).toBeNull();
  });
});

describe("pay-link Blink", () => {
  it("picks the newest person who joined, and builds the dial.to link and solana-action URI for their pay action", async () => {
    const db = await createTestDb();
    expect(await newestHandle(db)).toBeNull();
    await createUser(db, { phone: "+15550000050", handle: "alex" }, new Date("2026-10-01T00:00:00Z"));
    await createUser(db, { phone: "+15550000051", handle: "sam" }, new Date("2026-10-02T00:00:00Z"));
    expect(await newestHandle(db)).toBe("sam");

    expect(blinkFor("https://dial.example", "sam", true)).toEqual({
      actionUrl: "https://dial.example/api/actions/pay/sam",
      uri: "solana-action:https://dial.example/api/actions/pay/sam",
      blink: "https://dial.to/?action=solana-action%3Ahttps%3A%2F%2Fdial.example%2Fapi%2Factions%2Fpay%2Fsam&cluster=devnet",
    });
  });
});

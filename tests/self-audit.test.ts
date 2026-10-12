import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { intents, wallets } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import { createIntent } from "@/lib/intents";
import { everything, type Exposure, largestCapped, loadExposure, usersCapped, usersTotal } from "@/lib/self-audit/exposure";
import { scenarios } from "@/lib/self-audit/scenarios";
import { createTestDb } from "./helpers/db";
import { fakeAdapter } from "./helpers/fakes";

const usd = (n: number) => BigInt(n) * 1_000_000n;
const now = new Date("2026-10-12T19:00:00Z");
const facts = {
  perPayment: "$50",
  perDay: "$200",
  passkeyAbove: "$20",
  signupDrop: "$2",
  escrowDays: 7,
  perDayCap: usd(200),
  upgradeAuthority: "GFFm…gs88",
};

describe("what's at stake", () => {
  const e: Exposure = { balances: [usd(5), usd(250), usd(30)], escrows: { count: 2, amount: usd(7) }, treasury: usd(40) };

  it("adds people's wallets, caps each at the daily limit, and finds the worst single day", () => {
    expect(usersTotal(e)).toBe(usd(285));
    expect(usersCapped(e, usd(200))).toBe(usd(235));
    expect(largestCapped(e, usd(200))).toBe(usd(200));
    expect(everything(e)).toBe(usd(332));
  });

  it("says nothing it couldn't read", () => {
    const blind: Exposure = { balances: null, escrows: { count: 0, amount: 0n }, treasury: null };
    expect(usersTotal(blind)).toBeNull();
    expect(usersCapped(blind, usd(200))).toBeNull();
    expect(largestCapped(blind, usd(200))).toBeNull();
    expect(everything(blind)).toBeNull();
    expect(everything({ ...e, treasury: null })).toBeNull();
  });

  it("prices every case from the exposure, never from copy, and every case says how to harden it", () => {
    const cases = scenarios(facts);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const byId = Object.fromEntries(cases.map((c) => [c.id, c.loss(e)]));
    expect(byId.server?.amount).toBe(usd(332));
    expect(byId["wallet-key"]?.amount).toBe(usd(285));
    expect(byId.codes?.amount).toBe(usd(235));
    expect(byId.attestor).toEqual({ amount: usd(7), basis: "Every live escrow (2)" });
    expect(byId.upgrade?.amount).toBe(usd(7));
    expect(byId.treasury?.amount).toBe(usd(40));
    expect(byId.phone?.amount).toBe(usd(200));
    expect(byId.webhook?.amount).toBe(0n);
    for (const c of cases) {
      expect(c.harden.length).toBeGreaterThan(0);
      expect(c.inPlace.length).toBeGreaterThan(0);
      expect(`${c.title} ${c.worst} ${c.harden.join(" ")}`).not.toMatch(/\bfirst ever\b|\bonly one\b|—/);
    }
    // Worst first: the severities never get worse further down the page.
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    const ranks = cases.map((c) => rank[c.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe("loadExposure", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("reads each Solana wallet and the treasury from the chain, and live escrows from the ledger", async () => {
    const sol = fakeAdapter({ chain: "solana" });
    const alex = await createUser(db, { phone: "+15550000120", handle: "alex" });
    const sam = await createUser(db, { phone: "+15550000121", handle: "sam" });
    await db.insert(wallets).values([
      { userId: alex.id, chain: "solana", address: "AlexSol", secretEnc: "x" },
      { userId: sam.id, chain: "solana", address: "SamSol", secretEnc: "x" },
      { userId: sam.id, chain: "base", address: "0xSam", secretEnc: "x" },
    ]);
    sol.balances.set("AlexSol", usd(3));
    sol.balances.set("SamSol", usd(4));
    sol.balances.set("solanaTreasury", usd(40));
    const base = {
      kind: "send" as const,
      createdBy: alex.id,
      senderId: alex.id,
      recipientId: sam.id,
      chain: "solana" as const,
      token: "Mint",
      recipientAddress: "Vault",
      amount: usd(5),
      note: null,
    };
    const live = await createIntent(db, base, now);
    const expired = await createIntent(db, base, now);
    const later = new Date(now.getTime() + 86_400_000);
    await db.update(intents).set({ status: "escrowed", escrowExpiresAt: later }).where(eq(intents.id, live.id));
    await db.update(intents).set({ status: "escrowed", escrowExpiresAt: now }).where(eq(intents.id, expired.id));

    expect(await loadExposure(db, sol, now)).toEqual({
      balances: [usd(3), usd(4)],
      escrows: { count: 1, amount: usd(5) },
      treasury: usd(40),
    });
  });

  it("reports a balance it couldn't read as unknown instead of zero", async () => {
    const sol = fakeAdapter({ chain: "solana" });
    sol.getBalance = async () => {
      throw new Error("rpc down");
    };
    const alex = await createUser(db, { phone: "+15550000120", handle: "alex" });
    await db.insert(wallets).values({ userId: alex.id, chain: "solana", address: "AlexSol", secretEnc: "x" });
    expect(await loadExposure(db, sol, now)).toEqual({ balances: null, escrows: { count: 0, amount: 0n }, treasury: null });
  });
});

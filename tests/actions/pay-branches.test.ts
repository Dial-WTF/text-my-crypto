import { describe, expect, it } from "vitest";
import { type ActionsChain, newReference, payActionMetadata, preparePayment } from "@/lib/actions/pay";
import type { BotDeps } from "@/lib/bot/types";
import { actionPayments, users } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import type { PaymentActions } from "@/lib/settlement/capabilities";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, testDeps } from "../helpers/fakes";

const now = new Date("2026-10-09T12:00:00Z");
const PAYER = newReference();
const ALEX_WALLET = newReference();

async function setup(overrides: Partial<BotDeps> = {}) {
  const db = await createTestDb();
  await createUser(db, { phone: "+15550000010", handle: "alex", name: "Alex Rivera" }, now);
  const built: string[] = [];
  const actionsModule: PaymentActions = {
    blockchainId: "solana:test",
    buildPayment: async ({ reference }) => {
      built.push(reference);
      return "dHg=";
    },
    findByReference: async () => [],
  };
  const adapter = { ...fakeAdapter({ defaultBalance: 100_000_000n }), createWallet: async () => ({ address: ALEX_WALLET, secret: new Uint8Array(32) }) };
  const deps = testDeps(db, { adapters: { solana: { ...adapter, actions: actionsModule } }, now: () => now, ...overrides });
  const on: ActionsChain = { chain: "solana", adapter, module: actionsModule };
  return { db, deps, adapter, on, built };
}

describe("pay action on mainnet", () => {
  it("says real USDC on the mainnet network, with no test wording", async () => {
    const { deps } = await setup({ network: "mainnet" });
    const body = payActionMetadata(deps, "solana", { handle: "alex", name: "Alex Rivera" }, {});
    expect(body.description).toBe(
      "Send Alex Rivera (@alex) USDC on Solana from any wallet. It lands in their Dial wallet and they get a text receipt. Powered by Dial.Work.",
    );
  });

  it("names the chain itself where the network has no registry entry", async () => {
    const { deps } = await setup({ network: "mainnet" });
    // Zcash has no mainnet entry yet.
    expect(payActionMetadata(deps, "zcash", { handle: "alex", name: null }, {}).description).toContain("USDC on zcash from any wallet");
  });

  it("a thin mainnet wallet is refused without pointing at a faucet, and nothing is stored", async () => {
    const { db, deps, adapter, on, built } = await setup({ network: "mainnet" });
    adapter.balances.set(PAYER, 2_000_000n);
    expect(await preparePayment(deps, on, { handle: "alex", account: PAYER, amount: "5" })).toEqual({
      ok: false,
      status: 400,
      message: "This wallet has $2 in USDC, not $5.",
    });
    expect(built).toEqual([]);
    expect(await db.select().from(actionPayments)).toEqual([]);
  });
});

describe("pay action metadata for a user without a handle", () => {
  it("never puts 'undefined' or 'null' in the links it hands out", async () => {
    const { deps } = await setup();
    const body = payActionMetadata(deps, "solana", { handle: null, name: null }, { amount: "5" });
    expect(body.title).toBe("Pay @ $5");
    expect(body.icon).toBe("https://tmc.test/pay//card?amount=5");
    expect(JSON.stringify(body)).not.toMatch(/undefined|null/);
  });
});

describe("open references per handle", () => {
  it("counts only unpaid, unexpired ones toward the cap", async () => {
    const { db, deps, on } = await setup();
    const [alex] = await db.select().from(users);
    if (!alex) throw new Error("no alex");
    const row = (i: number, extra: Partial<typeof actionPayments.$inferInsert>) => ({
      id: `ap_${i}`,
      reference: `ref_${i}`,
      recipientId: alex.id,
      chain: "solana" as const,
      recipientAddress: ALEX_WALLET,
      payerAddress: PAYER,
      amount: 1_000_000n,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      ...extra,
    });
    // 29 open, plus a paid one and an expired one that don't count.
    await db.insert(actionPayments).values([
      ...Array.from({ length: 29 }, (_, i) => row(i, {})),
      row(100, { signature: "SigPaid" }),
      row(101, { expiresAt: now }),
    ]);
    expect((await preparePayment(deps, on, { handle: "alex", account: PAYER, amount: "1" })).ok).toBe(true);
    expect(await preparePayment(deps, on, { handle: "alex", account: PAYER, amount: "1" })).toMatchObject({ ok: false, status: 429 });
  });
});

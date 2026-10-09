import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { recordActionPayments } from "@/lib/actions/record";
import type { BotDeps } from "@/lib/bot/types";
import { actionPayments } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import type { PaymentActions } from "@/lib/settlement/capabilities";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

type PaymentFound = Awaited<ReturnType<PaymentActions["findByReference"]>>[number];

const now = new Date("2026-10-09T12:00:00Z");
const ALEX_PHONE = "+15550000010";
const ALEX_WALLET = "AlexWallet1111111111111111111111111111111111";
const PAYER = "PayerWallet111111111111111111111111111111111";

/** An `actions` module whose chain holds whatever payments a test lands, by reference. */
function fakeActions() {
  const landed = new Map<string, PaymentFound[]>();
  const actions: PaymentActions = {
    blockchainId: "solana:test",
    buildPayment: async () => "unused",
    findByReference: async (reference) => landed.get(reference) ?? [],
  };
  const land = (reference: string, txHash: string, amount: bigint, payer = PAYER) =>
    landed.set(reference, [...(landed.get(reference) ?? []), { txHash, explorerUrl: `https://explorer.test/${txHash}`, payer, amount }]);
  return { module: actions, land };
}

async function setup(overrides: Partial<BotDeps> = {}) {
  const db = await createTestDb();
  const alex = await createUser(db, { phone: ALEX_PHONE, handle: "alex", name: "Alex Rivera" }, now);
  const sms = smsSink();
  const actions = fakeActions();
  const deps = testDeps(db, {
    adapters: { solana: { ...fakeAdapter(), actions: actions.module } },
    sendSms: sms.sendSms,
    now: () => now,
    ...overrides,
  });
  const pending = async (id: string, opts: { chain?: "solana" | "base"; recipientId?: string; expiresAt?: Date } = {}) => {
    await db.insert(actionPayments).values({
      id,
      reference: `ref_${id}`,
      recipientId: opts.recipientId ?? alex.id,
      chain: opts.chain ?? "solana",
      recipientAddress: ALEX_WALLET,
      payerAddress: PAYER,
      amount: 5_000_000n,
      note: null,
      createdAt: now,
      expiresAt: opts.expiresAt ?? new Date(now.getTime() + 30 * 60_000),
    });
    return `ref_${id}`;
  };
  const row = async (id: string) => (await db.select().from(actionPayments).where(eq(actionPayments.id, id)))[0];
  return { db, alex, sms, actions, deps, pending, row };
}

describe("recording pay-action payments", () => {
  it("leaves a switched-off chain's references alone, even past expiry, until the chain is back", async () => {
    const { deps, pending, row, actions } = await setup();
    const ref = await pending("ap_base", { chain: "base", expiresAt: new Date(now.getTime() - 60_000) });
    // base is enabled but has no `actions` module; arbitrum isn't enabled at all.
    const withBase = { ...deps, adapters: { ...deps.adapters, base: fakeAdapter({ chain: "base" }) } };
    expect(await recordActionPayments(withBase)).toEqual({ recorded: 0, expired: 0, errors: 0 });
    expect(await recordActionPayments(deps)).toEqual({ recorded: 0, expired: 0, errors: 0 });
    expect(await row("ap_base")).toMatchObject({ signature: null });

    // Back on, with the payment landed: it's recorded, not dropped as expired.
    actions.land(ref, "SigBase", 5_000_000n);
    const back = { ...deps, adapters: { ...deps.adapters, base: { ...fakeAdapter({ chain: "base" }), actions: actions.module } } };
    expect(await recordActionPayments(back)).toEqual({ recorded: 1, expired: 0, errors: 0 });
    expect(await row("ap_base")).toMatchObject({ signature: "SigBase", received: 5_000_000n });
  });

  it("a database failure while recording isn't taken for 'already recorded': the row stays for the next pass", async () => {
    const { db, deps, pending, row, actions, sms } = await setup();
    const ref = await pending("ap_one");
    actions.land(ref, "SigOne", 5_000_000n);
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return () => {
            throw new Error("D1_ERROR: database is locked");
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    expect(await recordActionPayments({ ...deps, db: broken })).toEqual({ recorded: 0, expired: 0, errors: 1 });
    expect(await row("ap_one")).toMatchObject({ signature: null });
    expect(sms.to(ALEX_PHONE)).toEqual([]);

    expect(await recordActionPayments(deps)).toEqual({ recorded: 1, expired: 0, errors: 0 });
    expect(await row("ap_one")).toMatchObject({ signature: "SigOne" });
    expect(sms.to(ALEX_PHONE)).toHaveLength(1);
  });

  it("skips a transaction already recorded for another reference and records the next one that paid", async () => {
    const { deps, pending, row, actions } = await setup();
    const one = await pending("ap_one");
    const two = await pending("ap_two");
    actions.land(one, "SigShared", 5_000_000n);
    actions.land(two, "SigShared", 5_000_000n);
    actions.land(two, "SigOwn", 4_000_000n);
    expect((await recordActionPayments(deps)).recorded).toBe(2);
    const recorded = [(await row("ap_one"))?.signature, (await row("ap_two"))?.signature].sort();
    expect(recorded).toEqual(["SigOwn", "SigShared"]);
  });

  it("still records the payment when there is no recipient to text", async () => {
    const { db, deps, pending, row, actions, sms } = await setup();
    // Foreign keys stop this in production; the pass must not depend on it to keep the money's record.
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    const ref = await pending("ap_ghost", { recipientId: "u_gone" });
    actions.land(ref, "SigGhost", 5_000_000n);
    expect(await recordActionPayments(deps)).toEqual({ recorded: 1, expired: 0, errors: 0 });
    expect(await row("ap_ghost")).toMatchObject({ signature: "SigGhost", received: 5_000_000n, paidAt: now });
    expect(sms.sent).toEqual([]);
  });

  it("names a short payer address whole in the receipt, a long one shortened", async () => {
    const { deps, pending, actions, sms } = await setup();
    actions.land(await pending("ap_short"), "SigShort", 1_000_000n, "Short1");
    actions.land(await pending("ap_long"), "SigLong", 2_000_000n);
    expect((await recordActionPayments(deps)).recorded).toBe(2);
    expect([...sms.to(ALEX_PHONE)].sort()).toEqual([
      "Alex Rivera, you got $1 from Short1 on Solana. Receipt: https://explorer.test/SigShort",
      `Alex Rivera, you got $2 from ${PAYER.slice(0, 4)}...${PAYER.slice(-4)} on Solana. Receipt: https://explorer.test/SigLong`,
    ]);
  });
});

import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWallet } from "@/lib/bot/accounts";
import { approveIntent, declineLatest, reclaimExpired, reconcileEscrows, releaseEscrow, resumeUnknownSettlements } from "@/lib/bot/settle";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { type Intent, intents, users } from "@/lib/db/schema";
import { createUnclaimedUser, createUser } from "@/lib/identity";
import { createIntent, getIntent, type NewIntent } from "@/lib/intents";
import { seal } from "@/lib/secretbox";
import { SettlementUnknownError } from "@/lib/settlement/unconfirmed";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, type FakeEscrow, fakeAdapter, fakeEscrow, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000201";
const JEREMY = "+15550000202";
const NEWBIE = "+15550000203";
const DAY = 86_400_000;

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let escrow: FakeEscrow;
let sol: FakeAdapter;
let alexId: string;
let jeremyId: string;
let now: Date;

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  escrow = fakeEscrow();
  sol = fakeAdapter({ defaultBalance: 100_000_000n, escrow });
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: sol } });
  now = deps.now();
  alexId = (await createUser(db, { phone: ALEX, handle: "alex", name: "alex" }, now)).id;
  jeremyId = (await createUser(db, { phone: JEREMY, handle: "jeremy" }, now)).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A $10 send from Alex to Jeremy on Solana, created at `at` (default now). */
async function newIntent(over: Partial<NewIntent> = {}, at = now): Promise<Intent> {
  return createIntent(
    db,
    {
      kind: "send",
      createdBy: alexId,
      senderId: alexId,
      recipientId: jeremyId,
      chain: "solana",
      token: "Mint111",
      recipientAddress: "jeremyAddr",
      amount: 10_000_000n,
      note: null,
      ...over,
    },
    at,
  );
}

async function setRow(id: string, values: Partial<Intent>): Promise<void> {
  await db.update(intents).set(values).where(eq(intents.id, id));
}

async function row(id: string): Promise<Intent> {
  const i = await getIntent(db, id);
  if (!i) throw new Error(`intent ${id} missing`);
  return i;
}

/** A user row gone from under its payments (a bad migration, a hand-run delete): foreign keys off to allow it. */
async function dropUser(id: string): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.delete(users).where(eq(users.id, id));
}

/** An escrow held in a server-side wallet (the pre-program kind), expiring `expiresInMs` from now. */
async function walletEscrow(expiresInMs: number, over: Partial<NewIntent> = {}): Promise<Intent> {
  const i = await newIntent({ escrowSecretEnc: await seal(new Uint8Array(32), deps.walletKey), ...over });
  await setRow(i.id, { status: "escrowed", txHash: "sig_fund", escrowExpiresAt: new Date(now.getTime() + expiresInMs) });
  return row(i.id);
}

/** An escrow held by the program, expiring `expiresInMs` from now. */
async function programEscrow(expiresInMs: number): Promise<Intent> {
  const i = await newIntent({ escrowProgram: escrow.programId });
  await setRow(i.id, { status: "escrowed", txHash: "sig_fund", escrowExpiresAt: new Date(now.getTime() + expiresInMs) });
  return row(i.id);
}

describe("approveIntent", () => {
  it("won't settle a payment that already settled", async () => {
    const i = await newIntent();
    await setRow(i.id, { status: "settled", txHash: "sig_old" });
    expect(await approveIntent(deps, i.id)).toEqual({ ok: false, reason: "not_claimable" });
    expect(sol.settled).toEqual([]);
    expect(sms.sent).toEqual([]);
  });

  it("fails without sending when the recipient's account is gone", async () => {
    await ensureWallet(deps, alexId, "solana", sol);
    const i = await newIntent();
    await dropUser(jeremyId);
    expect(await approveIntent(deps, i.id)).toEqual({ ok: false, reason: "failed", error: "Missing sender or recipient" });
    expect(sol.settled).toEqual([]);
    expect((await row(i.id)).status).toBe("failed");
  });

  it("fails without sending on a chain that's switched off, and tells the sender", async () => {
    const i = await newIntent({ chain: "base", recipientAddress: "0x0000000000000000000000000000000000000001" });
    const out = await approveIntent(deps, i.id);
    expect(out).toEqual({ ok: false, reason: "failed", error: "No adapter for base" });
    expect(sol.settled).toEqual([]);
    expect(await row(i.id)).toMatchObject({ status: "failed", error: "No adapter for base" });
    expect(sms.to(ALEX)).toEqual(["That payment didn't go through. No funds moved."]);
  });

  it("fails without sending when the sender has no wallet on the chain", async () => {
    const i = await newIntent();
    expect(await approveIntent(deps, i.id)).toEqual({ ok: false, reason: "failed", error: "Missing sender wallet" });
    expect(sol.settled).toEqual([]);
    expect((await row(i.id)).status).toBe("failed");
  });

  it("refuses a payment the balance covers but its carried network fees don't", async () => {
    const w = await ensureWallet(deps, alexId, "solana", sol);
    const fees = vi.fn(() => 1_000_000n);
    sol.carriedFees = fees;
    sol.balances.set(w.address, 10_500_000n);
    const i = await newIntent();
    const out = await approveIntent(deps, i.id);
    expect(out).toEqual({ ok: false, reason: "failed", error: "Not enough for the network fees at approval" });
    // Jeremy is on Dial, so it goes to a Dial wallet.
    expect(fees).toHaveBeenCalledWith("dial");
    expect(sol.settled).toEqual([]);
    expect((await row(i.id)).status).toBe("failed");
    expect(sms.to(ALEX)).toEqual([
      "You have $10.50, but on Solana that payment also needs $1 for network fees, so I didn't send it. Nothing moved. Try a little less.",
    ]);
  });
});

describe("resumeUnknownSettlements", () => {
  async function unknownSend(): Promise<Intent> {
    await ensureWallet(deps, alexId, "solana", sol);
    const i = await newIntent();
    await setRow(i.id, { status: "settling", approvedAt: now, error: "outcome unknown: timeout" });
    return row(i.id);
  }

  it("two overlapping runs send it once", async () => {
    const i = await unknownSend();
    const [a, b] = await Promise.all([resumeUnknownSettlements(deps), resumeUnknownSettlements(deps)]);
    expect([...a, ...b]).toHaveLength(1);
    expect(sol.settled).toHaveLength(1);
    expect(sol.settled[0]).toMatchObject({ memo: i.id, amount: 10_000_000n });
    expect((await row(i.id)).status).toBe("settled");
  });

  it("an answer that is still unknown stays settling, and nobody is texted again", async () => {
    const i = await unknownSend();
    const settle = sol.settle;
    sol.settle = async (args) => {
      await settle(args);
      throw new SettlementUnknownError("solana", new Error("504 gateway timeout"));
    };
    const [out] = await resumeUnknownSettlements(deps);
    expect(out).toMatchObject({ ok: false, reason: "unconfirmed" });
    const after = await row(i.id);
    expect(after.status).toBe("settling");
    expect(after.error).toMatch(/^outcome unknown: solana RPC unavailable: 504 gateway timeout/);
    expect(sms.sent).toEqual([]);
  });
});

describe("releaseEscrow", () => {
  it("reports not claimable for a payment that doesn't exist or already settled, and expired for a lapsed escrow", async () => {
    expect(await releaseEscrow(deps, "pi_missing")).toEqual({ ok: false, reason: "not_claimable" });
    const settled = await walletEscrow(DAY);
    await setRow(settled.id, { status: "settled" });
    expect(await releaseEscrow(deps, settled.id)).toEqual({ ok: false, reason: "not_claimable" });
    const lapsed = await walletEscrow(-60_000);
    expect(await releaseEscrow(deps, lapsed.id)).toEqual({
      ok: false,
      reason: "expired",
      error: "Escrow expired before it was claimed",
    });
    expect((await row(lapsed.id)).status).toBe("escrowed");
    expect(sol.settled).toEqual([]);
  });

  it("keeps the money in escrow when the recipient hasn't claimed their account", async () => {
    const newbieId = (await createUnclaimedUser(db, NEWBIE)).id;
    const i = await walletEscrow(DAY, { recipientId: newbieId });
    expect(await releaseEscrow(deps, i.id)).toEqual({ ok: false, reason: "failed", error: "Recipient has not claimed their account" });
    expect(await row(i.id)).toMatchObject({ status: "escrowed", error: "Recipient has not claimed their account" });
    expect(sol.settled).toEqual([]);
  });

  it("keeps the money in escrow when the chain is switched off", async () => {
    const i = await walletEscrow(DAY, { chain: "base" });
    expect(await releaseEscrow(deps, i.id)).toEqual({ ok: false, reason: "failed", error: "No adapter for base" });
    expect(await row(i.id)).toMatchObject({ status: "escrowed", error: "No adapter for base" });
    expect(sms.sent).toEqual([]);
  });

  it("keeps an escrowed payment with no escrow recorded where it is, and sends nothing", async () => {
    const i = await newIntent();
    await setRow(i.id, { status: "escrowed", escrowExpiresAt: new Date(now.getTime() + DAY) });
    expect(await releaseEscrow(deps, i.id)).toEqual({ ok: false, reason: "failed", error: "Intent has no escrow" });
    expect(await row(i.id)).toMatchObject({ status: "escrowed", error: "Intent has no escrow" });
    expect(sol.settled).toEqual([]);
  });
});

describe("reclaimExpired", () => {
  it("refunds a program escrow without the sender's key when they have no wallet there", async () => {
    const refund = vi.spyOn(escrow, "refund");
    const i = await programEscrow(-DAY);
    expect(await reclaimExpired(deps, alexId)).toBe("Got back $10 from 1 unclaimed payment.");
    expect(refund).toHaveBeenCalledWith({ intentId: i.id, senderSecret: undefined });
    expect(await row(i.id)).toMatchObject({ status: "refunded", releaseTxHash: `sig_refund_${i.id}` });
  });

  it("two overlapping reclaims refund it once", async () => {
    const w = await ensureWallet(deps, alexId, "solana", sol);
    const i = await walletEscrow(-DAY);
    const replies = await Promise.all([reclaimExpired(deps, alexId), reclaimExpired(deps, alexId)]);
    expect(replies.sort()).toEqual([
      "Got back $10 from 1 unclaimed payment.",
      "Nothing to reclaim right now. Unclaimed payments can come back after 7 days.",
    ]);
    expect(sol.settled).toEqual([{ to: w.address, amount: 10_000_000n, memo: i.id, closeSource: true }]);
    expect((await row(i.id)).status).toBe("refunded");
  });

  it("a refund that fails leaves the escrow to try again, with the error on it", async () => {
    await ensureWallet(deps, alexId, "solana", sol);
    sol.settle = () => Promise.reject(new Error("rpc 503"));
    const i = await walletEscrow(-DAY);
    expect(await reclaimExpired(deps, alexId)).toBe("Nothing to reclaim right now. Unclaimed payments can come back after 7 days.");
    expect(await row(i.id)).toMatchObject({ status: "escrowed", error: "rpc 503" });
  });

  it("records a late claim as paid even when the recipient's account is gone, and texts nobody", async () => {
    const i = await programEscrow(-DAY);
    const result = { txHash: "sig_claim_late", explorerUrl: "https://explorer.test/sig_claim_late" };
    escrow.chain.set(i.id, { state: "claimed", result });
    await dropUser(jeremyId);
    expect(await reclaimExpired(deps, alexId)).toBe("Nothing to reclaim right now. Unclaimed payments can come back after 7 days.");
    expect(await row(i.id)).toMatchObject({ status: "settled", releaseTxHash: "sig_claim_late" });
    expect(escrow.calls).toEqual([]);
    expect(sms.sent).toEqual([]);
  });
});

describe("reconcileEscrows", () => {
  /** A program escrow funding that went out and never confirmed, approved `approvedAgoMs` ago. */
  async function unconfirmedFunding(approvedAgoMs: number | null, createdAt = now): Promise<Intent> {
    const i = await newIntent({ escrowProgram: escrow.programId }, createdAt);
    await setRow(i.id, {
      status: "settling",
      approvedAt: approvedAgoMs === null ? null : new Date(now.getTime() - approvedAgoMs),
      error: "Escrow unconfirmed: blockhash poll timed out",
    });
    return row(i.id);
  }

  /** What the chain says when this funding did land: Alex's escrow, for the amount he approved. */
  async function fundedOnChain(i: Intent): Promise<void> {
    const w = await ensureWallet(deps, alexId, "solana", sol);
    escrow.chain.set(i.id, {
      state: "open",
      sender: w.address,
      amount: i.amount,
      expiresAt: new Date(now.getTime() + 7 * DAY),
      funded: { txHash: "sig_create_late", explorerUrl: "https://explorer.test/sig_create_late" },
    });
  }

  it("leaves alone an escrow on a program the chain no longer runs", async () => {
    const i = await unconfirmedFunding(20 * 60_000);
    await setRow(i.id, { escrowProgram: "OldEscrow11111111111111111111111111111111111" });
    const lookup = vi.spyOn(escrow, "lookup");
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 0 });
    expect(lookup).not.toHaveBeenCalled();
    expect((await row(i.id)).status).toBe("settling");
  });

  it("waits when the chain can't be asked, and calls nothing failed", async () => {
    const i = await unconfirmedFunding(20 * 60_000);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(escrow, "lookup").mockRejectedValue(new Error("429 too many requests"));
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 0 });
    expect(logged).toHaveBeenCalledWith("escrow lookup failed", i.id, "429 too many requests");
    expect((await row(i.id)).status).toBe("settling");
    expect(sms.sent).toEqual([]);
  });

  it("leaves it settling when the sender's account is gone, even though the chain says funded", async () => {
    const i = await unconfirmedFunding(60_000);
    await fundedOnChain(i);
    await dropUser(alexId);
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 0 });
    expect((await row(i.id)).status).toBe("settling");
    expect(sms.sent).toEqual([]);
  });

  it("times a payment with no approval time from when it was created", async () => {
    const old = await unconfirmedFunding(null, new Date(now.getTime() - 20 * 60_000));
    const fresh = await unconfirmedFunding(null, new Date(now.getTime() - 60_000));
    expect(await reconcileEscrows(deps)).toEqual({ escrowed: 0, failed: 1 });
    expect(await row(old.id)).toMatchObject({ status: "failed", error: "Escrow funding never landed" });
    // Created a minute ago, it could still land.
    expect((await row(fresh.id)).status).toBe("settling");
    expect(sms.to(ALEX)).toEqual(["That payment didn't go through. No funds moved."]);
  });

  it("two overlapping runs announce a late funding once", async () => {
    const i = await unconfirmedFunding(60_000);
    await fundedOnChain(i);
    const [a, b] = await Promise.all([reconcileEscrows(deps), reconcileEscrows(deps)]);
    expect(a.escrowed + b.escrowed).toBe(1);
    expect(await row(i.id)).toMatchObject({ status: "escrowed", txHash: "sig_create_late", error: null });
    expect(sms.to(ALEX)).toEqual(["Sent $10 to jeremy. They reply YES to my text and it's theirs. If they don't within 7 days, text RECLAIM to get it back."]);
    expect(sms.to(JEREMY)).toHaveLength(1);
  });

  it("two overlapping runs fail a funding that never landed once", async () => {
    const i = await unconfirmedFunding(20 * 60_000);
    const [a, b] = await Promise.all([reconcileEscrows(deps), reconcileEscrows(deps)]);
    expect(a.failed + b.failed).toBe(1);
    expect((await row(i.id)).status).toBe("failed");
    expect(sms.to(ALEX)).toEqual(["That payment didn't go through. No funds moved."]);
  });
});

describe("declineLatest", () => {
  it("declines the request even when the requester's account is gone, and texts nobody", async () => {
    // Jeremy asked Alex for $10: Alex pays, Jeremy receives.
    const i = await newIntent({ kind: "request", createdBy: jeremyId });
    await dropUser(jeremyId);
    expect(await declineLatest(deps, alexId)).toBe("Declined. Nothing was paid.");
    expect((await row(i.id)).status).toBe("declined");
    expect(sms.sent).toEqual([]);
  });
});

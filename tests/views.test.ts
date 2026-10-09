import { describe, expect, it } from "vitest";
import { createUnclaimedUser, createUser } from "@/lib/identity";
import { claimForSettlement, createIntent, getIntent, issueCode, markEscrowed } from "@/lib/intents";
import { buildPaymentView } from "@/lib/views/payment";
import { receiptWords } from "@/lib/web/receipt-card";
import { createTestDb } from "./helpers/db";

const now = new Date("2026-10-09T12:00:00Z");
const publicView = { network: "testnet", audience: "public" } as const;

async function setup() {
  const db = await createTestDb();
  const a = await createUser(db, { phone: "+15550000010", handle: "alex", name: "Alex Rivera" }, now);
  const u = await createUnclaimedUser(db, "+15550000099");
  const i = await createIntent(
    db,
    { kind: "send", createdBy: a.id, senderId: a.id, recipientId: u.id, chain: "solana", token: "M", recipientAddress: "E", amount: 5_000_000n, note: "pizza" },
    now,
  );
  await issueCode(db, i.id);
  return { db, i };
}

describe("buildPaymentView", () => {
  it("describes a pending payment and an escrow waiting to be claimed", async () => {
    const { db, i } = await setup();
    const pending = await buildPaymentView(db, (await getIntent(db, i.id))!, now, publicView);
    expect(pending).toMatchObject({
      kindLabel: "Payment",
      from: "Alex Rivera",
      to: "+•••••••0099",
      note: "pizza",
      network: "Solana devnet",
      status: { label: "Awaiting approval", tone: "waiting" },
      approve: { passkey: false, code: true },
    });

    await claimForSettlement(db, i.id, now);
    await markEscrowed(db, i.id, { txHash: "F", explorerUrl: "https://x/F" }, new Date(now.getTime() + 7 * 86_400_000));
    const escrowed = await buildPaymentView(db, (await getIntent(db, i.id))!, now, publicView);
    expect(escrowed).toMatchObject({ status: { label: "Waiting to be claimed" }, approve: null, funding: { hash: "F" } });
    expect(escrowed.deadline?.label).toBe("Claim by");

    const late = await buildPaymentView(db, i, new Date(now.getTime() + 11 * 60_000), publicView);
    expect(late.status).toEqual({ label: "Expired", tone: "bad" });
  });

  it("shows only @handles and no note on a public receipt once the payment is past pending", async () => {
    const { db, i } = await setup();
    await claimForSettlement(db, i.id, now);
    await markEscrowed(db, i.id, { txHash: "F", explorerUrl: "https://x/F" }, new Date(now.getTime() + 7 * 86_400_000));
    const escrowed = (await getIntent(db, i.id))!;

    const view = await buildPaymentView(db, escrowed, now, publicView);
    expect(view).toMatchObject({ from: "@alex", to: "someone new", note: null });
    expect(JSON.stringify(view, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/Alex Rivera|0099|pizza/);

    for (const status of ["settled", "refunded", "failed", "declined"] as const) {
      const v = await buildPaymentView(db, { ...escrowed, status }, now, publicView);
      expect(v).toMatchObject({ from: "@alex", to: "someone new", note: null });
    }
  });

  it("shows only @handles and no note on a share card, even while the payment is pending", async () => {
    const { db, i } = await setup();
    const pending = (await getIntent(db, i.id))!;
    const card = await buildPaymentView(db, pending, now, { network: "testnet", audience: "card" });
    expect(card).toMatchObject({ from: "@alex", to: "someone new", note: null, status: { label: "Awaiting approval" } });

    const words = receiptWords(card);
    expect(words).toEqual({
      title: "$5 USDC payment · Awaiting approval",
      description: expect.stringMatching(/^@alex → someone new on Solana devnet\. /),
    });
    for (const v of [card, words]) {
      expect(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))).not.toMatch(/Alex Rivera|0099|pizza/);
    }
  });

  it("keeps names and the note for the account owner", async () => {
    const { db, i } = await setup();
    const settled = { ...(await getIntent(db, i.id))!, status: "settled" as const };
    const view = await buildPaymentView(db, settled, now, { network: "testnet", audience: "party" });
    expect(view).toMatchObject({ from: "Alex Rivera", to: "+•••••••0099", note: "pizza" });
  });

  it("names the network the payment settles on", async () => {
    const { db, i } = await setup();
    const intent = (await getIntent(db, i.id))!;
    expect((await buildPaymentView(db, intent, now, publicView)).network).toBe("Solana devnet");
    expect((await buildPaymentView(db, intent, now, { ...publicView, network: "mainnet" })).network).toBe("Solana");
  });
});

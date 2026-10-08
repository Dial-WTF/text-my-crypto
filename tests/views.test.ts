import { describe, expect, it } from "vitest";
import { createUnclaimedUser, createUser } from "@/lib/identity";
import { claimForSettlement, createIntent, getIntent, issueCode, markEscrowed } from "@/lib/intents";
import { buildPaymentView } from "@/lib/views/payment";
import { createTestDb } from "./helpers/db";

describe("buildPaymentView", () => {
  it("describes a pending payment and an escrow waiting to be claimed", async () => {
    const db = await createTestDb();
    const now = new Date("2026-10-09T12:00:00Z");
    const a = await createUser(db, { phone: "+15550000010", handle: "alex" }, now);
    const u = await createUnclaimedUser(db, "+15550000099");
    const i = await createIntent(
      db,
      { kind: "send", createdBy: a.id, senderId: a.id, recipientId: u.id, chain: "solana", token: "M", recipientAddress: "E", amount: 5_000_000n, note: "pizza" },
      now,
    );
    await issueCode(db, i.id);
    const pending = await buildPaymentView(db, (await getIntent(db, i.id))!, now);
    expect(pending).toMatchObject({
      kindLabel: "Payment",
      from: "alex",
      to: "+•••••••0099",
      network: "Solana devnet",
      status: { label: "Awaiting approval", tone: "waiting" },
      approve: { passkey: false, code: true },
    });

    await claimForSettlement(db, i.id, now);
    await markEscrowed(db, i.id, { txHash: "F", explorerUrl: "https://x/F" }, new Date(now.getTime() + 7 * 86_400_000));
    const escrowed = await buildPaymentView(db, (await getIntent(db, i.id))!, now);
    expect(escrowed).toMatchObject({ status: { label: "Waiting to be claimed" }, approve: null, funding: { hash: "F" } });
    expect(escrowed.deadline?.label).toBe("Claim by");

    const late = await buildPaymentView(db, i, new Date(now.getTime() + 11 * 60_000));
    expect(late.status).toEqual({ label: "Expired", tone: "bad" });
  });
});

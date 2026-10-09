import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FEATURE_DEMOS } from "@/app/chains/_demos";
import type { Db } from "@/lib/db/client";
import { createUser } from "@/lib/identity";
import { claimForSettlement, createIntent, getIntent, markSettled } from "@/lib/intents";
import { buildPaymentView } from "@/lib/views/payment";
import { cardAmount, receiptWords } from "@/lib/web/receipt-card";
import { PaymentReceipt } from "@/ui/patterns/PaymentReceipt/PaymentReceipt";
import { createTestDb } from "./helpers/db";

let db: Db;
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
const NOW = new Date("2026-10-09T12:00:00Z");
let giftId = "";

beforeAll(async () => {
  db = await createTestDb();
  const alex = await createUser(db, { phone: "+15550000010", handle: "alex", name: "Alex" }, NOW);
  const sam = await createUser(db, { phone: "+15550000011", handle: "sam", name: "Sam" }, NOW);
  const gift = await createIntent(
    db,
    {
      kind: "send",
      createdBy: alex.id,
      senderId: alex.id,
      recipientId: sam.id,
      chain: "robinhood",
      token: TSLA,
      recipientAddress: "0x000000000000000000000000000000000000dEaD",
      amount: 100_000n,
      note: null,
    },
    NOW,
  );
  await claimForSettlement(db, gift.id, NOW);
  await markSettled(db, gift.id, { txHash: "0xabc", explorerUrl: "https://explorer.testnet.chain.robinhood.com/tx/0xabc" }, NOW);
  giftId = gift.id;
});

describe("a stock gift on every public surface: shares and the ticker, never dollars", () => {
  it("the /a/<id> receipt and its share card", async () => {
    const i = await getIntent(db, giftId);
    const view = await buildPaymentView(db, i!, NOW, { network: "testnet", audience: "card" });
    expect(cardAmount(view)).toBe("0.1 TSLA");
    expect(receiptWords(view).title).toBe("0.1 TSLA payment · Settled");
    const html = renderToStaticMarkup(createElement(PaymentReceipt, { view }));
    expect(html).toContain("0.1 TSLA");
    expect(html).not.toContain("$");
  });

  it("the ledger feed, Watch it settle and ledger.json", async () => {
    const { loadLedger, loadLatestPayment } = await import("@/app/ledger-data");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ledger = await loadLedger(10);
    expect(ledger.feed[0]).toMatchObject({ id: giftId, amount: 100_000n, stock: "TSLA" });
    expect(ledger.stats).toMatchObject({ payments: 1, movedUsd: 0n });

    expect(await loadLatestPayment("robinhood")).toMatchObject({ id: giftId, amount: "0.1 TSLA" });

    const { GET } = await import("@/app/ledger.json/route");
    const body = (await (await GET()).json()) as { payments: Array<Record<string, unknown>> };
    expect(body.payments[0]).toMatchObject({ id: giftId, amountUsd: null, shares: "0.1", asset: "TSLA", shielded: false });
  });

  it("the assets demo on /chains/robinhood lists the stock tokens, even with no adapter built", async () => {
    const Demo = FEATURE_DEMOS.assets;
    expect(Demo).not.toBeNull();
    const node = await Demo!({ chain: "robinhood", network: "testnet", name: "Robinhood Chain", adapter: null });
    const html = renderToStaticMarkup(createElement("div", null, node));
    for (const s of ["TSLA · Tesla", "AMZN · Amazon", "PLTR · Palantir", "NFLX · Netflix", "AMD · AMD"]) expect(html).toContain(s);
    expect(html).toContain(TSLA);
    expect(html).toContain("send @alex 0.1 TSLA");
  });
});

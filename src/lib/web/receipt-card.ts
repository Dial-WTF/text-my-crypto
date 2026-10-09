import { cache } from "react";
import { getDb } from "@/lib/db/client";
import { publicEnv } from "@/lib/env";
import { getIntent } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { buildPaymentView, type PaymentView } from "@/lib/views/payment";

/**
 * The payment behind /a/<id> as a link preview sees it: @handles only, no note, at every status.
 * Cached per request, since the page's metadata and the card both ask. Null for an unknown id.
 */
export const loadReceiptCard = cache(async (intentId: string): Promise<PaymentView | null> => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(intentId)) return null;
  const db = getDb();
  const intent = await getIntent(db, intentId);
  if (!intent) return null;
  return buildPaymentView(db, intent, new Date(), { network: publicEnv().NETWORK, audience: "card" });
});

/** "$5 USDC", or "Shielded" for a private send. */
export const cardAmount = (v: Pick<PaymentView, "amount">) => (v.amount === null ? "Shielded" : `${formatUsd(v.amount)} USDC`);

/** The words a preview of /a/<id> uses, for the OG tags and the card. Nothing a "card" view leaves out. */
export function receiptWords(v: PaymentView): { title: string; description: string } {
  const kind = v.kindLabel.toLowerCase();
  return {
    title: v.amount === null ? `${v.kindLabel} · ${v.status.label}` : `${cardAmount(v)} ${kind} · ${v.status.label}`,
    description: `${v.from} → ${v.to} on ${v.network}. Every Dial payment is approved by a code texted to the payer, or their passkey, and settles on-chain.`,
  };
}

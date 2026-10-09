import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { notify } from "@/lib/bot/text";
import type { BotDeps } from "@/lib/bot/types";
import { chainLabel } from "@/lib/chains";
import { type ActionPayment, actionPayments } from "@/lib/db/schema";
import { displayName, getUserById } from "@/lib/identity";
import { formatUsd } from "@/lib/money";
import { replies } from "@/lib/operator/replies";
import type { PaymentActions } from "@/lib/settlement/capabilities";
import { errorText } from "@/lib/settlement/types";

/**
 * Pending references looked up per run, newest first: a real payment lands within minutes of its POST,
 * so a flood of unpaid ones can't push it out of the batch. Each costs at least one RPC call.
 */
const BATCH = 100;
/** Unpaid references this far past expiry are dropped without a last look, so a backlog can't grow forever. */
const PURGE_AFTER_MS = 24 * 60 * 60_000;

/** "7xKX...9fQa": three dots, not an ellipsis, so the text stays GSM-7. */
function shortWallet(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a;
}

export type RecordReport = { recorded: number; expired: number; errors: number };

/**
 * The every-minute pass over pay-action references: asks the chain's `actions` module for each one's
 * payment, records the first confirmed one that paid the recipient (as from the wallet it came from) and
 * texts them a receipt. A row's signature is set at most once, and signatures are unique across rows,
 * so a payment is never recorded or texted twice, even if two passes overlap. A reference past its
 * expiry with nothing found is deleted; one whose lookup failed is kept for the next pass.
 */
export async function recordActionPayments(deps: Pick<BotDeps, "db" | "sendSms" | "now" | "adapters">): Promise<RecordReport> {
  const report: RecordReport = { recorded: 0, expired: 0, errors: 0 };
  await deps.db
    .delete(actionPayments)
    .where(and(isNull(actionPayments.signature), lt(actionPayments.expiresAt, new Date(deps.now().getTime() - PURGE_AFTER_MS))));
  const pending = await deps.db
    .select()
    .from(actionPayments)
    .where(isNull(actionPayments.signature))
    .orderBy(desc(actionPayments.createdAt))
    .limit(BATCH);
  for (const row of pending) {
    // A chain switched off since: leave its rows for when it is back, or for the purge.
    const actions = deps.adapters[row.chain]?.actions;
    if (!actions) continue;
    try {
      if (await recordOne(deps, actions, row)) report.recorded++;
      else if (row.expiresAt <= deps.now()) {
        await deps.db.delete(actionPayments).where(and(eq(actionPayments.id, row.id), isNull(actionPayments.signature)));
        report.expired++;
      }
    } catch (e) {
      report.errors++;
      console.error(JSON.stringify({ evt: "action_payment", id: row.id, error: errorText(e) }));
    }
  }
  return report;
}

async function recordOne(deps: Pick<BotDeps, "db" | "sendSms" | "now">, actions: PaymentActions, row: ActionPayment): Promise<boolean> {
  for (const paid of await actions.findByReference(row.reference, row.recipientAddress)) {
    let claimed: ActionPayment[];
    try {
      claimed = await deps.db
        .update(actionPayments)
        .set({ signature: paid.txHash, explorerUrl: paid.explorerUrl, received: paid.amount, payerAddress: paid.payer, paidAt: deps.now() })
        .where(and(eq(actionPayments.id, row.id), isNull(actionPayments.signature)))
        .returning();
    } catch (e) {
      // The signature is unique: a transaction that carries two references only counts for the first.
      if (/unique/i.test(errorText(e))) continue;
      throw e;
    }
    // Another pass got here first.
    if (claimed.length === 0) return false;
    const recipient = await getUserById(deps.db, row.recipientId);
    if (recipient) {
      await notify(
        deps,
        recipient.phone,
        replies.received(
          displayName(recipient),
          formatUsd(paid.amount),
          shortWallet(paid.payer),
          chainLabel(row.chain),
          row.note,
          paid.explorerUrl,
        ),
      );
    }
    console.log(JSON.stringify({ evt: "action_payment", id: row.id, recorded: paid.txHash, received: paid.amount.toString() }));
    return true;
  }
  return false;
}

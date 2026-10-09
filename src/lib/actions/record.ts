import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { notify } from "@/lib/bot/text";
import type { BotDeps } from "@/lib/bot/types";
import { chainLabel } from "@/lib/chains";
import { type ActionPayment, actionPayments } from "@/lib/db/schema";
import { displayName, getUserById } from "@/lib/identity";
import { formatUsd } from "@/lib/money";
import { replies } from "@/lib/operator/replies";
import type { SolanaNetwork } from "@/lib/settlement/registry";
import { errorText } from "@/lib/settlement/types";
import type { ActionChainReader, ConfirmedTx } from "./rpc";

/**
 * Pending references looked up per run, newest first: a real payment lands within minutes of its POST,
 * so a flood of unpaid ones can't push it out of the batch. Each costs one RPC call.
 */
const BATCH = 100;
/** Unpaid references this far past expiry are dropped without a last look, so a backlog can't grow forever. */
const PURGE_AFTER_MS = 24 * 60 * 60_000;

/** "7xKX...9fQa": three dots, not an ellipsis, so the text stays GSM-7. */
export function shortWallet(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a;
}

/**
 * What a confirmed transaction paid `recipient` in `mint`: its token accounts' gain, and the wallet whose
 * balance of that mint fell the most (else the fee payer). Null when it failed or paid them nothing.
 */
export function paidTo(tx: ConfirmedTx, mint: string, recipient: string): { received: bigint; from: string } | null {
  if (tx.err) return null;
  const deltas = new Map<number, { owner?: string; delta: bigint }>();
  for (const [rows, sign] of [
    [tx.pre, -1n],
    [tx.post, 1n],
  ] as const) {
    for (const b of rows) {
      if (b.mint !== mint) continue;
      const d = deltas.get(b.accountIndex) ?? { owner: b.owner, delta: 0n };
      d.owner ??= b.owner;
      d.delta += sign * BigInt(b.uiTokenAmount.amount);
      deltas.set(b.accountIndex, d);
    }
  }
  let received = 0n;
  let from: { owner?: string; delta: bigint } | null = null;
  for (const d of deltas.values()) {
    if (d.owner === recipient) received += d.delta;
    else if (d.delta < 0n && (!from || d.delta < from.delta)) from = d;
  }
  return received > 0n ? { received, from: from?.owner ?? tx.feePayer } : null;
}

export type RecordReport = { recorded: number; expired: number; errors: number };

/**
 * The every-minute pass over pay-action references: finds each one's transaction on-chain, records the
 * first confirmed one that paid the recipient (as a payment from the wallet it came from) and texts
 * them a receipt. A row's signature is set at most once, and the signature is unique across rows, so a
 * payment is never recorded or texted twice, even if two passes overlap. References past their expiry
 * with nothing found are deleted; one whose lookup failed is kept for the next pass.
 */
export async function recordActionPayments(
  deps: Pick<BotDeps, "db" | "sendSms" | "now">,
  chain: { entry: SolanaNetwork; reader: ActionChainReader },
): Promise<RecordReport> {
  const report: RecordReport = { recorded: 0, expired: 0, errors: 0 };
  await deps.db
    .delete(actionPayments)
    .where(and(isNull(actionPayments.signature), lt(actionPayments.expiresAt, new Date(deps.now().getTime() - PURGE_AFTER_MS))));
  const pending = await deps.db
    .select()
    .from(actionPayments)
    .where(and(eq(actionPayments.chain, "solana"), isNull(actionPayments.signature)))
    .orderBy(desc(actionPayments.createdAt))
    .limit(BATCH);
  for (const row of pending) {
    try {
      if (await recordOne(deps, chain, row)) report.recorded++;
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

async function recordOne(
  deps: Pick<BotDeps, "db" | "sendSms" | "now">,
  { entry, reader }: { entry: SolanaNetwork; reader: ActionChainReader },
  row: ActionPayment,
): Promise<boolean> {
  const sigs = (await reader.signatures(row.reference)).filter((s) => !s.err).reverse();
  for (const { signature } of sigs) {
    const tx = await reader.transaction(signature);
    const paid = tx ? paidTo(tx, entry.mint, row.recipientAddress) : null;
    if (!paid) continue;
    const now = deps.now();
    let claimed: ActionPayment[];
    try {
      claimed = await deps.db
        .update(actionPayments)
        .set({ signature, explorerUrl: entry.explorerTx(signature), received: paid.received, payerAddress: paid.from, paidAt: now })
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
          formatUsd(paid.received),
          shortWallet(paid.from),
          chainLabel("solana"),
          row.note,
          entry.explorerTx(signature),
        ),
      );
    }
    console.log(JSON.stringify({ evt: "action_payment", id: row.id, recorded: signature, received: paid.received.toString() }));
    return true;
  }
  return false;
}

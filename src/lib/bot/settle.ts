import { chainLabel } from "@/lib/chains";
import type { Intent } from "@/lib/db/schema";
import { describe, displayName, getUserById, isClaimed } from "@/lib/identity";
import {
  claimEscrowForRefund,
  claimEscrowForRelease,
  claimForSettlement,
  declineIntent,
  expiredEscrowsFrom,
  latestPendingRequestFor,
  markEscrowed,
  markFailed,
  markReleased,
  markSettled,
  revertToEscrowed,
} from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { replies } from "@/lib/operator/replies";
import { open } from "@/lib/secretbox";
import { isOptedOut } from "@/lib/sms/optout";
import { getWallet, unsealWallet } from "@/lib/wallets";
import { ensureWallet } from "./accounts";
import { notify } from "./text";
import type { BotDeps } from "./types";

export type SettleOutcome =
  | { ok: true; status: "settled" | "escrowed"; txHash: string; explorerUrl: string }
  | { ok: false; reason: "not_claimable" | "failed"; error?: string };

const DAY_MS = 86_400_000;

/** Executes an approved PaymentIntent: pays the recipient directly, or funds the payment's escrow if they aren't on Dial yet. */
export async function approveIntent(deps: BotDeps, intentId: string): Promise<SettleOutcome> {
  const intent = await claimForSettlement(deps.db, intentId, deps.now());
  if (!intent) return { ok: false, reason: "not_claimable" };

  const [sender, recipient] = await Promise.all([
    getUserById(deps.db, intent.senderId),
    getUserById(deps.db, intent.recipientId),
  ]);
  if (!sender || !recipient) {
    await markFailed(deps.db, intent.id, "Missing sender or recipient");
    return { ok: false, reason: "failed", error: "Missing sender or recipient" };
  }

  let result: { txHash: string; explorerUrl: string };
  try {
    const adapter = deps.adapters[intent.chain];
    if (!adapter) throw new Error(`No adapter for ${intent.chain}`);
    const wallet = await getWallet(deps.db, intent.senderId, intent.chain);
    if (!wallet) throw new Error("Missing sender wallet");
    const balance = await adapter.getBalance(wallet.address);
    if (balance < intent.amount) {
      await markFailed(deps.db, intent.id, "Insufficient balance at approval");
      await notify(deps, sender.phone, replies.insufficientNow(formatUsd(balance)));
      return { ok: false, reason: "failed", error: "Insufficient balance at approval" };
    }
    const target = intent.kind === "withdraw" ? `${intent.recipientAddress.slice(0, 4)}…${intent.recipientAddress.slice(-4)}` : describe(recipient);
    await notify(deps, sender.phone, replies.sending(formatUsd(intent.amount), target, chainLabel(intent.chain)));
    result = await adapter.settle({
      fromSecret: await unsealWallet(wallet, deps.walletKey),
      to: intent.recipientAddress,
      amount: intent.amount,
      memo: intent.id,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await markFailed(deps.db, intent.id, error);
    await notify(deps, sender.phone, replies.failed());
    return { ok: false, reason: "failed", error };
  }

  const amount = formatUsd(intent.amount);
  const chain = chainLabel(intent.chain);

  if (intent.escrowSecretEnc) {
    await markEscrowed(deps.db, intent.id, result, new Date(deps.now().getTime() + deps.escrowTtlDays * DAY_MS));
    await notify(deps, sender.phone, replies.sentToEscrow(amount, displayName(recipient), deps.escrowTtlDays));
    if (await isOptedOut(deps.db, recipient.phone)) {
      await notify(deps, sender.phone, replies.recipientOptedOut(displayName(recipient), deps.escrowTtlDays));
    } else {
      await notify(deps, recipient.phone, replies.receivedUnclaimed(amount, displayName(sender), intent.note));
    }
    return { ok: true, status: "escrowed", ...result };
  }

  await markSettled(deps.db, intent.id, result, deps.now());
  if (intent.kind === "withdraw") {
    const short = `${intent.recipientAddress.slice(0, 4)}…${intent.recipientAddress.slice(-4)}`;
    await notify(deps, sender.phone, replies.withdrew(amount, short, result.explorerUrl));
    return { ok: true, status: "settled", ...result };
  }
  await notify(deps, sender.phone, replies.sent(amount, displayName(recipient), chain, result.explorerUrl));
  if (intent.kind === "send") {
    await notify(
      deps,
      recipient.phone,
      replies.received(displayName(recipient), amount, displayName(sender), chain, intent.note),
    );
  } else {
    await notify(deps, recipient.phone, replies.requestPaid(displayName(sender), amount, intent.note, result.explorerUrl));
  }
  return { ok: true, status: "settled", ...result };
}

async function moveEscrow(deps: BotDeps, intent: Intent, toUserId: string): Promise<{ txHash: string; explorerUrl: string }> {
  const adapter = deps.adapters[intent.chain];
  if (!adapter) throw new Error(`No adapter for ${intent.chain}`);
  if (!intent.escrowSecretEnc) throw new Error("Intent has no escrow");
  const to = await ensureWallet(deps, toUserId, intent.chain, adapter);
  return adapter.settle({
    fromSecret: await open(intent.escrowSecretEnc, deps.walletKey),
    to: to.address,
    amount: intent.amount,
    memo: intent.id,
    closeSource: true,
  });
}

/** Pays an escrow out to its recipient. Caller must have verified phone custody (claim code). */
export async function releaseEscrow(deps: BotDeps, intentId: string): Promise<SettleOutcome> {
  const intent = await claimEscrowForRelease(deps.db, intentId);
  if (!intent) return { ok: false, reason: "not_claimable" };
  const [sender, recipient] = await Promise.all([
    getUserById(deps.db, intent.senderId),
    getUserById(deps.db, intent.recipientId),
  ]);
  if (!sender || !recipient || !isClaimed(recipient)) {
    await revertToEscrowed(deps.db, intent.id, "Recipient has not claimed their account");
    return { ok: false, reason: "failed", error: "Recipient has not claimed their account" };
  }
  try {
    const result = await moveEscrow(deps, intent, recipient.id);
    await markReleased(deps.db, intent.id, "settled", result, deps.now());
    const amount = formatUsd(intent.amount);
    await notify(deps, recipient.phone, replies.claimed(amount, displayName(sender), result.explorerUrl));
    await notify(deps, sender.phone, replies.escrowClaimed(displayName(recipient), amount));
    return { ok: true, status: "settled", ...result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await revertToEscrowed(deps.db, intent.id, error);
    return { ok: false, reason: "failed", error };
  }
}

/** Refunds every expired, unclaimed escrow the user sent. Returns the reply text. */
export async function reclaimExpired(deps: BotDeps, senderId: string): Promise<string> {
  const expired = await expiredEscrowsFrom(deps.db, senderId, deps.now());
  let total = 0n;
  let count = 0;
  for (const candidate of expired) {
    const intent = await claimEscrowForRefund(deps.db, candidate.id, deps.now());
    if (!intent) continue;
    try {
      const result = await moveEscrow(deps, intent, senderId);
      await markReleased(deps.db, intent.id, "refunded", result, deps.now());
      total += intent.amount;
      count++;
    } catch (e) {
      await revertToEscrowed(deps.db, intent.id, e instanceof Error ? e.message : String(e));
    }
  }
  return count > 0 ? replies.refunded(formatUsd(total), count) : replies.nothingToReclaim(deps.escrowTtlDays);
}

/** Declines the newest request or invoice waiting on this payer. */
export async function declineLatest(deps: BotDeps, payerId: string): Promise<string> {
  const intent = await latestPendingRequestFor(deps.db, payerId, deps.now());
  if (!intent || !(await declineIntent(deps.db, intent.id))) return replies.nothingToDecline();
  const [payer, requester] = await Promise.all([
    getUserById(deps.db, payerId),
    getUserById(deps.db, intent.recipientId),
  ]);
  if (payer && requester) {
    await notify(deps, requester.phone, replies.requestDeclined(displayName(payer), formatUsd(intent.amount)));
  }
  return replies.declined();
}

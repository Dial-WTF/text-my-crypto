import { chainLabel } from "@/lib/chains";
import type { Intent, User } from "@/lib/db/schema";
import { describe, displayName, getUserById, isClaimed } from "@/lib/identity";
import {
  claimEscrowForRefund,
  claimEscrowForRelease,
  claimForSettlement,
  declineIntent,
  expiredEscrowsFrom,
  getIntent,
  latestPendingRequestFor,
  markEscrowed,
  markFailed,
  markFundingUnconfirmed,
  markReleased,
  markSettled,
  revertToEscrowed,
  settleUnconfirmed,
  unconfirmedEscrowFunding,
} from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { money } from "@/lib/settlement/amounts";
import { replies } from "@/lib/operator/replies";
import { open } from "@/lib/secretbox";
import {
  EscrowClosedError,
  EscrowExpiredError,
  type EscrowProgram,
  EscrowUnconfirmedError,
  errorText,
  type SettleResult,
} from "@/lib/settlement/types";
import { isOptedOut } from "@/lib/sms/optout";
import { getWallet, unsealWallet } from "@/lib/wallets";
import { ensureWallet } from "./accounts";
import { notify } from "./text";
import type { BotDeps } from "./types";

export type SettleOutcome =
  | { ok: true; status: "settled" | "escrowed"; txHash: string; explorerUrl: string }
  | { ok: false; reason: "not_claimable" | "failed" | "expired" | "unconfirmed"; error?: string };

const DAY_MS = 86_400_000;
/** Refunds wait this long past expiry: the chain's clock can trail ours, and the program checks its own. */
const RECLAIM_MARGIN_MS = 5 * 60_000;
/** An escrow funding the chain still doesn't know about this long after approval never landed. */
const UNCONFIRMED_GIVE_UP_MS = 15 * 60_000;
/** Longer than any approval takes (a send waits at most about two minutes): still "settling" after this, the worker died. */
const STALE_SETTLING_MS = 5 * 60_000;

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
  const escrowExpiresAt = new Date(deps.now().getTime() + deps.escrowTtlDays * DAY_MS);
  try {
    const adapter = deps.adapters[intent.chain];
    if (!adapter) throw new Error(`No adapter for ${intent.chain}`);
    const wallet = await getWallet(deps.db, intent.senderId, intent.chain);
    if (!wallet) throw new Error("Missing sender wallet");
    const balance = await adapter.getBalance(wallet.address);
    if (balance < intent.amount) {
      await markFailed(deps.db, intent.id, "Insufficient balance at approval");
      await notify(deps, sender.phone, replies.insufficientNow(money(balance, intent.chain, deps.network)));
      return { ok: false, reason: "failed", error: "Insufficient balance at approval" };
    }
    const target = intent.kind === "withdraw" ? `${intent.recipientAddress.slice(0, 4)}…${intent.recipientAddress.slice(-4)}` : describe(recipient);
    await notify(deps, sender.phone, replies.sending(money(intent.amount, intent.chain, deps.network), target, chainLabel(intent.chain)));
    const fromSecret = await unsealWallet(wallet, deps.walletKey);
    result = intent.escrowProgram
      ? await escrowProgramFor(deps, intent).create({ fromSecret, intentId: intent.id, amount: intent.amount, expiresAt: escrowExpiresAt })
      : await adapter.settle({ fromSecret, to: intent.recipientAddress, amount: intent.amount, memo: intent.id });
  } catch (e) {
    const error = errorText(e);
    if (e instanceof EscrowUnconfirmedError) {
      // It may still land. Leave it settling; reconcileEscrows settles it from the chain.
      await markFundingUnconfirmed(deps.db, intent.id, error);
      await notify(deps, sender.phone, replies.sendUnconfirmed(formatUsd(intent.amount), describe(recipient)));
      return { ok: false, reason: "unconfirmed", error };
    }
    await markFailed(deps.db, intent.id, error);
    await notify(deps, sender.phone, replies.failed());
    return { ok: false, reason: "failed", error };
  }

  const amount = money(intent.amount, intent.chain, deps.network);
  const chain = chainLabel(intent.chain);

  if (intent.escrowSecretEnc || intent.escrowProgram) {
    await markEscrowed(deps.db, intent.id, result, escrowExpiresAt);
    await announceEscrowed(deps, intent, sender, recipient);
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
      replies.received(displayName(recipient), amount, displayName(sender), chain, intent.note, result.explorerUrl),
    );
  } else {
    await notify(deps, recipient.phone, replies.requestPaid(displayName(sender), amount, intent.note, result.explorerUrl));
  }
  return { ok: true, status: "settled", ...result };
}

/** The money is in escrow: the sender hears how long the recipient has, the recipient how to claim it. */
async function announceEscrowed(deps: BotDeps, intent: Intent, sender: User, recipient: User): Promise<void> {
  const amount = formatUsd(intent.amount);
  await notify(deps, sender.phone, replies.sentToEscrow(amount, displayName(recipient), deps.escrowTtlDays));
  if (await isOptedOut(deps.db, recipient.phone)) {
    await notify(deps, sender.phone, replies.recipientOptedOut(displayName(recipient), deps.escrowTtlDays));
  } else {
    await notify(deps, recipient.phone, replies.receivedUnclaimed(amount, displayName(sender), intent.note, `${deps.appUrl}/a/${intent.id}`));
  }
}

/** The escrow program holding this intent. The intent names its program, so a switched-off or changed program fails loudly. */
function escrowProgramFor(deps: BotDeps, intent: Intent): EscrowProgram {
  const program = deps.adapters[intent.chain]?.escrow;
  if (!program || program.programId !== intent.escrowProgram) {
    throw new Error(`Escrow program ${intent.escrowProgram} is not available on ${intent.chain}`);
  }
  return program;
}

/** Pays an escrow to its recipient (claim) or back to its sender (refund). */
async function moveEscrow(deps: BotDeps, intent: Intent, to: "recipient" | "sender"): Promise<{ txHash: string; explorerUrl: string }> {
  const adapter = deps.adapters[intent.chain];
  if (!adapter) throw new Error(`No adapter for ${intent.chain}`);
  const toUserId = to === "recipient" ? intent.recipientId : intent.senderId;
  if (intent.escrowProgram) {
    const program = escrowProgramFor(deps, intent);
    // The program only ever refunds to the sender's wallet it recorded, so a refund needs no address.
    if (to === "sender") return program.refund({ intentId: intent.id });
    const wallet = await ensureWallet(deps, toUserId, intent.chain, adapter);
    return program.claim({ intentId: intent.id, to: wallet.address });
  }
  if (!intent.escrowSecretEnc) throw new Error("Intent has no escrow");
  const wallet = await ensureWallet(deps, toUserId, intent.chain, adapter);
  return adapter.settle({
    fromSecret: await open(intent.escrowSecretEnc, deps.walletKey),
    to: wallet.address,
    amount: intent.amount,
    memo: intent.id,
    closeSource: true,
  });
}

/** Pays an escrow out to its recipient. Caller must have verified phone custody (claim code). */
export async function releaseEscrow(deps: BotDeps, intentId: string): Promise<SettleOutcome> {
  const intent = await claimEscrowForRelease(deps.db, intentId, deps.now());
  if (!intent) {
    const current = await getIntent(deps.db, intentId);
    const expired = current?.status === "escrowed" && current.escrowExpiresAt !== null && current.escrowExpiresAt <= deps.now();
    return expired ? { ok: false, reason: "expired", error: "Escrow expired before it was claimed" } : { ok: false, reason: "not_claimable" };
  }
  const [sender, recipient] = await Promise.all([
    getUserById(deps.db, intent.senderId),
    getUserById(deps.db, intent.recipientId),
  ]);
  if (!sender || !recipient || !isClaimed(recipient)) {
    await revertToEscrowed(deps.db, intent.id, "Recipient has not claimed their account");
    return { ok: false, reason: "failed", error: "Recipient has not claimed their account" };
  }
  try {
    const result = await moveEscrow(deps, intent, "recipient");
    await markReleased(deps.db, intent.id, "settled", result, deps.now());
    const amount = money(intent.amount, intent.chain, deps.network);
    await notify(deps, recipient.phone, replies.claimed(amount, displayName(sender), result.explorerUrl));
    await notify(deps, sender.phone, replies.escrowClaimed(displayName(recipient), amount));
    return { ok: true, status: "settled", ...result };
  } catch (e) {
    const error = errorText(e);
    if (e instanceof EscrowClosedError && e.outcome === "refunded") {
      // Someone already sent the refund (anyone can, after expiry): record it and tell the sender.
      await markReleased(deps.db, intent.id, "refunded", e.result, deps.now());
      await notify(deps, sender.phone, replies.refunded(formatUsd(intent.amount), 1));
      return { ok: false, reason: "expired", error };
    }
    await revertToEscrowed(deps.db, intent.id, error);
    return { ok: false, reason: e instanceof EscrowExpiredError ? "expired" : "failed", error };
  }
}

/** Refunds every expired, unclaimed escrow the user sent. Returns the reply text. */
export async function reclaimExpired(deps: BotDeps, senderId: string): Promise<string> {
  const cutoff = new Date(deps.now().getTime() - RECLAIM_MARGIN_MS);
  const expired = await expiredEscrowsFrom(deps.db, senderId, cutoff);
  let total = 0n;
  let count = 0;
  for (const candidate of expired) {
    const intent = await claimEscrowForRefund(deps.db, candidate.id, cutoff);
    if (!intent) continue;
    try {
      const result = await moveEscrow(deps, intent, "sender");
      await markReleased(deps.db, intent.id, "refunded", result, deps.now());
      total += intent.amount;
      count++;
    } catch (e) {
      if (e instanceof EscrowClosedError && e.outcome === "claimed") {
        // A claim we lost track of (it landed after we stopped waiting): it was paid, so say so.
        await recordLateClaim(deps, intent, e.result);
        continue;
      }
      await revertToEscrowed(deps.db, intent.id, errorText(e));
    }
  }
  return count > 0 ? replies.refunded(formatUsd(total), count) : replies.nothingToReclaim(deps.escrowTtlDays);
}

/** An escrow turned out to be claimed after all: mark it paid and tell both people. */
async function recordLateClaim(deps: BotDeps, intent: Intent, result: SettleResult): Promise<void> {
  await markReleased(deps.db, intent.id, "settled", result, deps.now());
  const [sender, recipient] = await Promise.all([getUserById(deps.db, intent.senderId), getUserById(deps.db, intent.recipientId)]);
  if (!sender || !recipient) return;
  const amount = formatUsd(intent.amount);
  await notify(deps, recipient.phone, replies.claimed(amount, displayName(sender), result.explorerUrl));
  await notify(deps, sender.phone, replies.escrowClaimed(displayName(recipient), amount));
}

/**
 * Program escrows whose funding didn't confirm while we waited (or whose worker died mid-send): settle
 * each from what the chain says. Funded with this sender's escrow for this amount: escrowed, and both
 * people hear about it. Nothing there 15 minutes after approval (long past the blockhash): failed.
 * Runs every minute alongside the watchdog.
 */
export async function reconcileEscrows(deps: BotDeps): Promise<{ escrowed: number; failed: number }> {
  const done = { escrowed: 0, failed: 0 };
  const now = deps.now().getTime();
  for (const intent of await unconfirmedEscrowFunding(deps.db, new Date(now - STALE_SETTLING_MS))) {
    const program = deps.adapters[intent.chain]?.escrow;
    if (!program || program.programId !== intent.escrowProgram) continue;
    const found = await program.lookup(intent.id).catch((e: unknown) => {
      console.error("escrow lookup failed", intent.id, errorText(e));
      return null;
    });
    if (!found) continue;
    const [sender, recipient] = await Promise.all([getUserById(deps.db, intent.senderId), getUserById(deps.db, intent.recipientId)]);
    if (!sender || !recipient) continue;
    const startedAt = (intent.approvedAt ?? intent.createdAt).getTime();
    if (found.state === "open" && found.funded) {
      // Only this payment's escrow: the sender's wallet and the amount they approved.
      const wallet = await getWallet(deps.db, intent.senderId, intent.chain);
      if (found.sender !== wallet?.address || found.amount !== intent.amount) {
        console.error("escrow does not match its payment", intent.id, found.sender, String(found.amount));
        continue;
      }
      const won = await settleUnconfirmed(deps.db, intent.id, {
        status: "escrowed",
        txHash: found.funded.txHash,
        explorerUrl: found.funded.explorerUrl,
        escrowExpiresAt: found.expiresAt,
      });
      if (won) {
        await announceEscrowed(deps, intent, sender, recipient);
        done.escrowed++;
      }
    } else if (found.state === "none" && now - startedAt > UNCONFIRMED_GIVE_UP_MS) {
      if (await settleUnconfirmed(deps.db, intent.id, { status: "failed", error: "Escrow funding never landed" })) {
        await notify(deps, sender.phone, replies.failed());
        done.failed++;
      }
    }
  }
  return done;
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
    await notify(deps, requester.phone, replies.requestDeclined(displayName(payer), money(intent.amount, intent.chain, deps.network)));
  }
  return replies.declined();
}

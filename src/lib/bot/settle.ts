import { chainLabel } from "@/lib/chains";
import type { Intent, User } from "@/lib/db/schema";
import { describe, displayName, getUserById, isClaimed } from "@/lib/identity";
import {
  claimEscrowForRefund,
  claimEscrowForRelease,
  claimForSettlement,
  claimUnknownForRetry,
  declineIntent,
  expiredEscrowsFrom,
  getIntent,
  latestPendingRequestFor,
  markEscrowed,
  markFailed,
  markFundingUnconfirmed,
  markOutcomeUnknown,
  markReleased,
  markSettled,
  revertToEscrowed,
  settleUnconfirmed,
  unconfirmedEscrowFunding,
  unknownSettlements,
} from "@/lib/intents";
import { liveExplorer } from "@/lib/explorers";
import { formatUsd } from "@/lib/money";
import { money } from "@/lib/settlement/amounts";
import { replies } from "@/lib/operator/replies";
import { withdrawTarget } from "@/lib/payment-labels";
import { open } from "@/lib/secretbox";
import {
  EscrowClosedError,
  EscrowExpiredError,
  type EscrowProgram,
  EscrowUnconfirmedError,
  errorText,
  type SettlementAdapter,
  type SettleResult,
} from "@/lib/settlement/types";
import type { VenueTransfer } from "@/lib/settlement/capabilities";
import { SettlementUnknownError, TransferUnconfirmedError } from "@/lib/settlement/unconfirmed";
import { isOptedOut } from "@/lib/sms/optout";
import { getWallet, unsealWallet } from "@/lib/wallets";
import { ensureWallet } from "./accounts";
import { approveSplit } from "./split";
import { notify } from "./text";
import type { BotDeps } from "./types";

export type SettleOutcome =
  | { ok: true; status: "settled" | "escrowed"; txHash: string; explorerUrl: string | null }
  /** "unconfirmed": the send went out but no answer came back. It stays "settling" and a minute job finishes it. */
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
  // A leg of a split is approved with the whole split, which settles in one transaction.
  const splitId = (await getIntent(deps.db, intentId))?.splitId;
  if (splitId) return approveSplit(deps, splitId);
  const intent = await claimForSettlement(deps.db, intentId, deps.now());
  if (!intent) return { ok: false, reason: "not_claimable" };
  return execute(deps, intent, { resume: false });
}

/**
 * Drives settlements whose outcome was unknown (a send went out and no answer came back) to an answer.
 * Only adapters with idempotent sends throw for that, so sending again with the same arguments returns
 * the transaction that already went out, or sends it if it never did. Run by the minute watchdog.
 */
export async function resumeUnknownSettlements(deps: BotDeps): Promise<SettleOutcome[]> {
  const outcomes: SettleOutcome[] = [];
  for (const candidate of await unknownSettlements(deps.db, deps.now())) {
    const intent = await claimUnknownForRetry(deps.db, candidate.id, deps.now());
    if (intent) outcomes.push(await execute(deps, intent, { resume: true }));
  }
  return outcomes;
}

/**
 * Settles a claimed intent. On a resume the balance check and the "Sending…" text are skipped: the money
 * may already have left, and the sender heard about it the first time.
 */
async function execute(deps: BotDeps, intent: Intent, { resume }: { resume: boolean }): Promise<SettleOutcome> {
  const [sender, recipient] = await Promise.all([
    getUserById(deps.db, intent.senderId),
    getUserById(deps.db, intent.recipientId),
  ]);
  if (!sender || !recipient) {
    await markFailed(deps.db, intent.id, "Missing sender or recipient");
    return { ok: false, reason: "failed", error: "Missing sender or recipient" };
  }

  let result: SettleResult;
  const escrowExpiresAt = new Date(deps.now().getTime() + deps.escrowTtlDays * DAY_MS);
  try {
    const adapter = deps.adapters[intent.chain];
    if (!adapter) throw new Error(`No adapter for ${intent.chain}`);
    const wallet = await getWallet(deps.db, intent.senderId, intent.chain);
    if (!wallet) throw new Error("Missing sender wallet");
    const goesTo = intent.kind === "withdraw" || intent.escrowProgram ? "outside" : intent.escrowSecretEnc ? "escrow" : "dial";
    const fees = adapter.carriedFees?.(goesTo) ?? 0n;
    const balance = resume ? intent.amount + fees : await adapter.getBalance(wallet.address);
    if (balance < intent.amount + fees) {
      const error = balance < intent.amount ? "Insufficient balance at approval" : "Not enough for the network fees at approval";
      await markFailed(deps.db, intent.id, error);
      const have = money(balance, intent.chain, deps.network);
      await notify(
        deps,
        sender.phone,
        balance < intent.amount
          ? replies.insufficientNow(have)
          : replies.feeShort(have, money(fees, intent.chain, deps.network), chainLabel(intent.chain)),
      );
      return { ok: false, reason: "failed", error };
    }
    const target = intent.kind === "withdraw" ? withdrawTarget(intent) : isOwnVenueMove(intent) ? "your spot balance" : describe(recipient);
    if (!resume) {
      await notify(deps, sender.phone, replies.sending(money(intent.amount, intent.chain, deps.network), target, paymentChain(intent)));
    }
    const fromSecret = await unsealWallet(wallet, deps.walletKey);
    result =
      intent.kind === "venue"
        ? await venueOf(adapter).deposit({ fromSecret, to: intent.recipientAddress, amount: intent.amount, memo: intent.id })
        : intent.escrowProgram
          ? await escrowProgramFor(deps, intent).create({ fromSecret, intentId: intent.id, amount: intent.amount, expiresAt: escrowExpiresAt })
          : await adapter.settle({
              fromSecret,
              to: intent.recipientAddress,
              amount: intent.amount,
              memo: intent.id,
              escrow: Boolean(intent.escrowSecretEnc),
            });
  } catch (e) {
    const error = errorText(e);
    if (intent.kind === "venue" && e instanceof TransferUnconfirmedError) {
      // Sent, but the receipt didn't come back: it may still land, so it is not called failed.
      await markFundingUnconfirmed(deps.db, intent.id, error);
      await notify(deps, sender.phone, replies.hyperCoreUnconfirmed(money(intent.amount, intent.chain, deps.network)));
      return { ok: false, reason: "unconfirmed", error };
    }
    if (e instanceof EscrowUnconfirmedError) {
      // It may still land. Leave it settling; reconcileEscrows settles it from the chain.
      await markFundingUnconfirmed(deps.db, intent.id, error);
      await notify(deps, sender.phone, replies.sendUnconfirmed(formatUsd(intent.amount), describe(recipient)));
      return { ok: false, reason: "unconfirmed", error };
    }
    if (e instanceof SettlementUnknownError) {
      // The money may have moved: never call it failed. resumeUnknownSettlements asks again with the
      // same arguments, which the adapter's idempotent sends turn into the same transaction.
      await markOutcomeUnknown(deps.db, intent.id, error);
      if (!resume) await notify(deps, sender.phone, replies.sendUnconfirmed(money(intent.amount, intent.chain, deps.network), describe(recipient)));
      return { ok: false, reason: "unconfirmed", error };
    }
    await markFailed(deps.db, intent.id, error);
    await notify(deps, sender.phone, replies.failed());
    return { ok: false, reason: "failed", error };
  }

  const amount = money(intent.amount, intent.chain, deps.network);
  const chain = paymentChain(intent);

  if (intent.escrowSecretEnc || intent.escrowProgram) {
    await markEscrowed(deps.db, intent.id, result, escrowExpiresAt);
    await announceEscrowed(deps, intent, sender, recipient);
    return { ok: true, status: "escrowed", ...result };
  }

  await markSettled(deps.db, intent.id, result, deps.now());
  if (intent.kind === "withdraw") {
    await notify(deps, sender.phone, replies.withdrew(amount, withdrawTarget(intent), receiptUrl(deps, intent, result)));
    return { ok: true, status: "settled", ...result };
  }
  if (isOwnVenueMove(intent)) {
    await notify(deps, sender.phone, replies.movedToHyperCore(amount, receiptUrl(deps, intent, result)));
    return { ok: true, status: "settled", ...result };
  }
  await notify(deps, sender.phone, replies.sent(amount, displayName(recipient), chain, receiptUrl(deps, intent, result)));
  if (intent.kind === "venue") {
    await notify(
      deps,
      recipient.phone,
      replies.receivedOnHyperCore(displayName(recipient), amount, displayName(sender), intent.note, receiptUrl(deps, intent, result)),
    );
  } else if (intent.kind === "send") {
    await notify(
      deps,
      recipient.phone,
      replies.received(displayName(recipient), amount, displayName(sender), chain, intent.note, receiptUrl(deps, intent, result)),
    );
  } else {
    await notify(deps, recipient.phone, replies.requestPaid(displayName(sender), amount, intent.note, receiptUrl(deps, intent, result)));
  }
  return { ok: true, status: "settled", ...result };
}

/** The explorer page for a payment's transaction, or Dial's own receipt where the chain has no working explorer. */
export function receiptUrl(deps: Pick<BotDeps, "appUrl">, intent: Pick<Intent, "id">, result: Pick<SettleResult, "explorerUrl">): string {
  return liveExplorer(result.explorerUrl) ?? `${deps.appUrl}/a/${intent.id}`;
}

/** A venue deposit into the sender's own account there. */
function isOwnVenueMove(intent: Intent): boolean {
  return intent.kind === "venue" && intent.recipientId === intent.senderId;
}

/** The chain people hear about: "Hyperliquid" for venue deposits (HyperCore is the only venue), else the intent's chain. */
function paymentChain(intent: Intent): string {
  return intent.kind === "venue" ? "Hyperliquid" : chainLabel(intent.chain);
}

function venueOf(adapter: SettlementAdapter): VenueTransfer {
  if (!adapter.venue) throw new Error(`No trading venue on ${adapter.chain}`);
  return adapter.venue;
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
async function moveEscrow(deps: BotDeps, intent: Intent, to: "recipient" | "sender"): Promise<SettleResult> {
  const adapter = deps.adapters[intent.chain];
  if (!adapter) throw new Error(`No adapter for ${intent.chain}`);
  const toUserId = to === "recipient" ? intent.recipientId : intent.senderId;
  if (intent.escrowProgram) {
    const program = escrowProgramFor(deps, intent);
    // The program only ever refunds to the sender's wallet it recorded, so a refund needs no address.
    // Some programs take the refund only on the sender's signature, so it gets their key.
    if (to === "sender") {
      const wallet = await getWallet(deps.db, intent.senderId, intent.chain);
      const senderSecret = wallet ? await unsealWallet(wallet, deps.walletKey) : undefined;
      return program.refund({ intentId: intent.id, senderSecret });
    }
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
    await notify(deps, recipient.phone, replies.claimed(amount, displayName(sender), receiptUrl(deps, intent, result)));
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
  await notify(deps, recipient.phone, replies.claimed(amount, displayName(sender), receiptUrl(deps, intent, result)));
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

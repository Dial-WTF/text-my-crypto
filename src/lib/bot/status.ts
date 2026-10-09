import type { Intent, User } from "@/lib/db/schema";
import { displayName, getUserById } from "@/lib/identity";
import { escrowedTo, intentsFor, isCodeLocked, issueSharedCode, latestInFlightFor } from "@/lib/intents";
import { money } from "@/lib/settlement/amounts";
import { replies } from "@/lib/operator/replies";
import { withdrawTarget } from "@/lib/payment-labels";
import { codeFor } from "./money";
import { splitStatusReply } from "./split";
import type { BotDeps } from "./types";

/** How far back "did it work?" looks. Older payments are history, not something in flight. */
const RECENT_MS = 24 * 60 * 60_000;

/**
 * The payment this person is most likely asking about, from the last day: one still waiting on them or
 * still moving (their own pending or settling payment, an escrow for them to claim), else their newest.
 * Money that landed for them a minute later doesn't hide the payment still waiting on their code.
 */
export async function latestRecent(deps: BotDeps, user: User): Promise<Intent | null> {
  const now = deps.now();
  const since = new Date(now.getTime() - RECENT_MS);
  const inFlight = await latestInFlightFor(deps.db, user.id, since, now);
  if (inFlight) return inFlight;
  const [latest] = await intentsFor(deps.db, user.id, 1);
  return latest && latest.createdAt > since ? latest : null;
}

const JUST_EXPIRED_MS = 30 * 60_000;

/**
 * True when their latest payment is waiting on them, still moving, or just expired unapproved:
 * worth saying before any small talk. Requests waiting on someone else don't count.
 */
export function needsMention(i: Intent | null, userId: string, now: Date): i is Intent {
  if (!i || i.senderId !== userId) return false;
  if (i.status === "settling") return true;
  return i.status === "pending" && now.getTime() - i.expiresAt.getTime() < JUST_EXPIRED_MS;
}

const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * "Did it work?": the state of their latest payment in one text. When it's waiting on their code,
 * a fresh code goes out with it, since the usual reason for asking is that the code never arrived.
 * Pass freshCode: false for an unprompted reminder.
 */
export async function statusReply(
  deps: BotDeps,
  user: User,
  latest?: Intent | null,
  { freshCode = true }: { freshCode?: boolean } = {},
): Promise<string> {
  const i = latest === undefined ? await latestRecent(deps, user) : latest;
  if (!i) return replies.nothingInFlight();
  const split = await splitStatusReply(deps, user, i, { freshCode });
  if (split) return split;
  const now = deps.now();
  const amount = money(i.amount, i.chain, deps.network);
  const outgoing = i.senderId === user.id;
  const otherId = outgoing ? i.recipientId : i.senderId;
  const other = await getUserById(deps.db, otherId);
  const who =
    i.kind === "withdraw"
      ? withdrawTarget(i)
      : other
        ? displayName(other)
        : "them";
  const link = `${deps.appUrl}/a/${i.id}`;

  switch (i.status) {
    case "pending": {
      if (i.expiresAt <= now) return replies.statusExpired(amount, who);
      if (!outgoing) return replies.statusWaitingOnThem(amount, who);
      // Locked by wrong codes: asking again must not buy more guesses.
      if (isCodeLocked(i)) return replies.codeMismatch(0);
      // A nudge must not replace a code that may still be on its way; only an explicit "status" does.
      if (!freshCode) return replies.statusReminder(amount, who);
      const code = await codeFor(deps, user.id, i.id, i.amount, { keepAttempts: true });
      return i.kind === "send" || i.kind === "withdraw"
        ? replies.statusWaitingOnYou(amount, who, code, link)
        : replies.statusAskedToPay(amount, who, code, link);
    }
    case "settling":
      return replies.statusSending(amount, who);
    case "settled":
      return outgoing ? replies.statusSent(amount, who, i.explorerUrl) : replies.statusReceived(amount, who, i.explorerUrl);
    case "escrowed": {
      if (outgoing) return replies.statusEscrowed(amount, who, i.escrowExpiresAt ? day(i.escrowExpiresAt) : "it expires");
      // Too late to claim: it can only go back to the sender now.
      if (i.escrowExpiresAt && i.escrowExpiresAt <= now) return replies.claimExpired(amount, who);
      // Waiting for this person to claim it: the same shared claim code as offerEscrowClaims, sent again.
      if (isCodeLocked(i)) return replies.codeMismatch(0);
      if (!freshCode) return replies.statusClaimWaiting(amount, who, null);
      const waiting = (await escrowedTo(deps.db, user.id, now)).filter((e) => !isCodeLocked(e));
      const code = await issueSharedCode(
        deps.db,
        waiting.map((e) => e.id),
        { keepAttempts: true },
      );
      return replies.statusClaimWaiting(amount, who, code);
    }
    case "refunded":
      return outgoing
        ? replies.statusRefunded(amount, i.releaseExplorerUrl ?? i.explorerUrl)
        : replies.statusReturnedToSender(amount, who);
    case "failed":
      return replies.statusFailed(amount, who);
    case "declined":
      return replies.statusCancelled(amount, who);
  }
}

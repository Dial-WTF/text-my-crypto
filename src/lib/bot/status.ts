import type { Intent, User } from "@/lib/db/schema";
import { displayName, getUserById } from "@/lib/identity";
import { intentsFor } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { replies } from "@/lib/operator/replies";
import { codeFor } from "./money";
import type { BotDeps } from "./types";

/** How far back "did it work?" looks. Older payments are history, not something in flight. */
const RECENT_MS = 24 * 60 * 60_000;

/** The payment this person is most likely asking about: their newest one from the last day. */
export async function latestRecent(deps: BotDeps, user: User): Promise<Intent | null> {
  const [latest] = await intentsFor(deps.db, user.id, 1);
  return latest && deps.now().getTime() - latest.createdAt.getTime() < RECENT_MS ? latest : null;
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
  const now = deps.now();
  const amount = formatUsd(i.amount);
  const outgoing = i.senderId === user.id;
  const otherId = outgoing ? i.recipientId : i.senderId;
  const other = await getUserById(deps.db, otherId);
  const who =
    i.kind === "withdraw"
      ? `${i.recipientAddress.slice(0, 4)}…${i.recipientAddress.slice(-4)}`
      : other
        ? displayName(other)
        : "them";
  const link = `${deps.appUrl}/a/${i.id}`;

  switch (i.status) {
    case "pending": {
      if (i.expiresAt <= now) return replies.statusExpired(amount, who);
      if (!outgoing) return replies.statusWaitingOnThem(amount, who);
      // A nudge must not replace a code that may still be on its way; only an explicit "status" does.
      if (!freshCode) return replies.statusReminder(amount, who);
      const code = await codeFor(deps, user.id, i.id, i.amount);
      return i.kind === "send" || i.kind === "withdraw"
        ? replies.statusWaitingOnYou(amount, who, code, link)
        : replies.statusAskedToPay(amount, who, code, link);
    }
    case "settling":
      return replies.statusSending(amount, who);
    case "settled":
      return outgoing ? replies.statusSent(amount, who, i.explorerUrl) : replies.statusReceived(amount, who, i.explorerUrl);
    case "escrowed":
      return outgoing
        ? replies.statusEscrowed(amount, who, i.escrowExpiresAt ? day(i.escrowExpiresAt) : "it expires")
        : replies.statusReceived(amount, who, i.explorerUrl);
    case "refunded":
      return replies.statusRefunded(amount, i.releaseExplorerUrl ?? i.explorerUrl);
    case "failed":
      return replies.statusFailed(amount, who);
    case "declined":
      return replies.statusCancelled(amount, who);
  }
}

import { MAX_CODE_ATTEMPTS } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import type { Intent, User } from "@/lib/db/schema";
import { displayName, getUserById } from "@/lib/identity";
import { networkName } from "@/lib/ledger";
import { hasPasskey } from "@/lib/passkeys";
import type { Network } from "@/lib/settlement/registry";

export type StatusTone = "done" | "waiting" | "bad";

export type TxRef = { hash: string; url: string | null };

export type PaymentView = {
  id: string;
  kindLabel: string;
  amount: bigint;
  from: string;
  to: string;
  network: string;
  note: string | null;
  status: { label: string; tone: StatusTone };
  deadline: { label: string; at: Date } | null;
  funding: TxRef | null;
  release: TxRef | null;
  approve: { passkey: boolean; code: boolean } | null;
  justSettled: boolean;
};

const KIND_LABEL: Record<Intent["kind"], string> = {
  send: "Payment",
  request: "Request",
  invoice: "Invoice",
  withdraw: "Withdrawal",
};

function statusOf(i: Intent, now: Date): PaymentView["status"] {
  if (i.status === "pending" && i.expiresAt <= now) return { label: "Expired", tone: "bad" };
  switch (i.status) {
    case "pending":
      return { label: "Awaiting approval", tone: "waiting" };
    case "settling":
      return { label: "Sending", tone: "waiting" };
    case "escrowed":
      return { label: "Waiting to be claimed", tone: "waiting" };
    case "settled":
      return { label: i.kind === "withdraw" ? "Withdrawn" : "Settled", tone: "done" };
    case "refunded":
      return { label: "Refunded", tone: "waiting" };
    case "failed":
      return { label: "Failed", tone: "bad" };
    case "declined":
      return { label: "Declined", tone: "bad" };
  }
}

/**
 * Who sees the view. "public" is the /a/<id> page, which anyone holding the id can open (ids are
 * on the public ledger): once a payment is past pending it names people by @handle only and drops
 * the note. A pending payment keeps names and note, since the payer needs them to approve.
 * "party" is for the account owner (their agent), who sees everything.
 */
export type PaymentAudience = "public" | "party";

/** "@handle" for people with one, "someone new" for a number that hasn't signed up. */
function publicName(u: User | null): string {
  if (!u) return "someone";
  return u.handle ? `@${u.handle}` : "someone new";
}

export async function buildPaymentView(
  db: Db,
  i: Intent,
  now: Date,
  opts: { network: Network; audience: PaymentAudience },
): Promise<PaymentView> {
  const [sender, recipient] = await Promise.all([getUserById(db, i.senderId), getUserById(db, i.recipientId)]);
  const open = i.status === "pending" && i.expiresAt > now;
  const full = opts.audience === "party" || i.status === "pending";
  const name = (u: User | null) => (full ? (u ? displayName(u) : "someone") : publicName(u));
  const to = i.kind === "withdraw" ? `${i.recipientAddress.slice(0, 4)}…${i.recipientAddress.slice(-4)}` : name(recipient);
  return {
    id: i.id,
    kindLabel: KIND_LABEL[i.kind],
    amount: i.amount,
    from: name(sender),
    to,
    network: networkName(i.chain, opts.network),
    note: full ? i.note : null,
    status: statusOf(i, now),
    deadline: open
      ? { label: "Approve by", at: i.expiresAt }
      : i.status === "escrowed" && i.escrowExpiresAt
        ? { label: "Claim by", at: i.escrowExpiresAt }
        : null,
    funding: i.txHash ? { hash: i.txHash, url: i.explorerUrl } : null,
    release: i.releaseTxHash ? { hash: i.releaseTxHash, url: i.releaseExplorerUrl } : null,
    approve: open
      ? {
          passkey: await hasPasskey(db, i.senderId),
          code: i.codeHash !== null && i.codeAttempts < MAX_CODE_ATTEMPTS,
        }
      : null,
    justSettled: i.status === "settled" && i.settledAt !== null && now.getTime() - i.settledAt.getTime() < 60_000,
  };
}

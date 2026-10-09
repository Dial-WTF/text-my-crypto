import { MAX_CODE_ATTEMPTS } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import type { Intent, User } from "@/lib/db/schema";
import { displayName, getUserById } from "@/lib/identity";
import { splitLegs } from "@/lib/intents";
import { networkName } from "@/lib/ledger";
import { hasPasskey } from "@/lib/passkeys";
import { withdrawTarget } from "@/lib/payment-labels";
import type { Network } from "@/lib/settlement/registry";

export type StatusTone = "done" | "waiting" | "bad";

type TxRef = { hash: string; url: string | null };

export type PaymentView = {
  id: string;
  kindLabel: string;
  /** Null when the payment is private and this audience isn't a party to it. */
  amount: bigint | null;
  /** A private, shielded Zcash send. */
  shielded: boolean;
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
  /** Set when this payment is one leg of a split: every leg, in order. `amount` is then the split's total. */
  split: { legs: Array<{ id: string; to: string; amount: bigint }> } | null;
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
 * "party" is for the account owner (their agent), who sees everything. "card" is the link preview for
 * /a/<id>: chat apps fetch and cache it for everyone in the thread, so it is @handles only and no note
 * at every status, pending included.
 */
export type PaymentAudience = "public" | "party" | "card";

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
  // A private send shows anyone but its owner only what the shielded chain does: that it happened, on
  // which chain, and its transaction id. No amount, names, note or address, at any status.
  const hidden = i.private && opts.audience !== "party";
  const full = !hidden && (opts.audience === "party" || (opts.audience === "public" && i.status === "pending"));
  const name = (u: User | null) => (hidden ? "someone" : full ? (u ? displayName(u) : "someone") : publicName(u));
  const split = i.splitId ? await splitView(db, i.splitId, name) : null;
  const to = i.kind === "withdraw" ? withdrawTarget(i) : split ? `${split.legs.length} people` : name(recipient);
  return {
    id: i.id,
    kindLabel: i.private ? "Shielded payment" : split ? "Split" : KIND_LABEL[i.kind],
    amount: hidden ? null : split ? split.legs.reduce((a, l) => a + l.amount, 0n) : i.amount,
    shielded: i.private,
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
    split,
  };
}

/** Every leg of the split, named for this audience. The legs share one approval and one transaction. */
async function splitView(db: Db, splitId: string, name: (u: User | null) => string): Promise<NonNullable<PaymentView["split"]>> {
  const legs = await splitLegs(db, splitId);
  const people = await Promise.all(legs.map((l) => getUserById(db, l.recipientId)));
  return { legs: legs.map((l, n) => ({ id: l.id, to: name(people[n] ?? null), amount: l.amount })) };
}

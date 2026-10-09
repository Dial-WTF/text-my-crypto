import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import { hashCode, MAX_CODE_ATTEMPTS, newCode } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import { type Intent, intents } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/hash";
import { newId, randomToken } from "@/lib/ids";
import { STOCK_TOKEN_ADDRESSES } from "@/lib/stocks";

const SEND_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60_000;

export type IntentKind = Intent["kind"];

export type NewIntent = {
  kind: IntentKind;
  createdBy: string;
  senderId: string;
  recipientId: string;
  chain: Chain;
  token: string;
  recipientAddress: string;
  /** The name recipientAddress was resolved from, when the person gave a name instead of an address. */
  recipientName?: string | null;
  amount: bigint;
  note: string | null;
  escrowSecretEnc?: string | null;
  escrowProgram?: string | null;
  /** A shielded Zcash send ("send … privately"). */
  private?: boolean;
  /** Preset when something keyed by the id (an escrow vault) has to be known before the row exists. */
  id?: string;
  /** Groups the legs of one split. */
  splitId?: string | null;
};

type Bound = Pick<
  Intent,
  | "id"
  | "kind"
  | "senderId"
  | "recipientId"
  | "chain"
  | "token"
  | "recipientAddress"
  | "amount"
  | "nonce"
  | "expiresAt"
>;

export function canonicalIntent(i: Bound): string {
  return JSON.stringify([
    "dial-intent-v1",
    i.id,
    i.kind,
    i.senderId,
    i.recipientId,
    i.chain,
    i.token,
    i.recipientAddress,
    i.amount.toString(),
    i.nonce,
    i.expiresAt.toISOString(),
  ]);
}

export function intentHash(i: Bound): Promise<string> {
  return sha256Hex(canonicalIntent(i));
}

export function newIntentId(): string {
  return newId("pi");
}

export async function createIntent(db: Db, n: NewIntent, now: Date): Promise<Intent> {
  const ttl = n.kind === "send" ? SEND_TTL_MS : REQUEST_TTL_MS;
  const [row] = await db
    .insert(intents)
    .values({ ...n, id: n.id ?? newIntentId(), nonce: randomToken(16), createdAt: now, expiresAt: new Date(now.getTime() + ttl) })
    .returning();
  if (!row) throw new Error("createIntent returned no row");
  return row;
}

export async function getIntent(db: Db, id: string): Promise<Intent | null> {
  const [row] = await db.select().from(intents).where(eq(intents.id, id)).limit(1);
  return row ?? null;
}

/**
 * How a code is issued. `keepAttempts` is for re-sending a code on a payment that already had one ("status",
 * a repeated command): the wrong guesses made so far still count, so asking for a new code never buys more tries.
 */
export type IssueOptions = { keepAttempts?: boolean };

/** Issues a fresh one-time code for the intent's current phase and returns it in plain text. */
export async function issueCode(db: Db, id: string, opts: IssueOptions = {}): Promise<string> {
  return issueSharedCode(db, [id], opts);
}

/** Issues one code shared by several intents (e.g. every escrow waiting for the same person). */
export async function issueSharedCode(db: Db, ids: string[], { keepAttempts = false }: IssueOptions = {}): Promise<string> {
  const code = newCode();
  for (const id of ids) {
    await db
      .update(intents)
      .set(keepAttempts ? { codeHash: await hashCode(id, code) } : { codeHash: await hashCode(id, code), codeAttempts: 0 })
      .where(eq(intents.id, id));
  }
  return code;
}

/** Too many wrong codes on this payment: no new code is issued for it. */
export function isCodeLocked(i: Pick<Intent, "codeAttempts">): boolean {
  return i.codeAttempts >= MAX_CODE_ATTEMPTS;
}

/** Intents a user can act on with a texted code: their own pending payments and escrows waiting for them. */
export async function codeCandidates(db: Db, userId: string, now: Date): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(
      and(
        isNotNull(intents.codeHash),
        lt(intents.codeAttempts, MAX_CODE_ATTEMPTS),
        or(
          and(eq(intents.senderId, userId), eq(intents.status, "pending"), gt(intents.expiresAt, now)),
          // Escrows waiting for this person, until they expire: then they can only go back to the sender.
          and(eq(intents.recipientId, userId), eq(intents.status, "escrowed"), gt(intents.escrowExpiresAt, now)),
        ),
      ),
    );
}

/**
 * Finds the candidates whose code matches; a miss costs every candidate an attempt. The attempt is taken
 * first, in one conditional UPDATE, and the code is compared only against the rows that UPDATE returned,
 * so guesses sent in parallel can't all read the same count and get past the limit. A hit gives the
 * attempt back to every candidate: a right code never counts as a wrong try.
 */
export async function matchCode(db: Db, candidates: Intent[], code: string): Promise<Intent[]> {
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => c.id);
  const charged = await db
    .update(intents)
    .set({ codeAttempts: sql`${intents.codeAttempts} + 1` })
    .where(and(inArray(intents.id, ids), isNotNull(intents.codeHash), lt(intents.codeAttempts, MAX_CODE_ATTEMPTS)))
    .returning({ id: intents.id, codeHash: intents.codeHash });
  const hits = new Set<string>();
  for (const c of charged) {
    if (c.codeHash && c.codeHash === (await hashCode(c.id, code))) hits.add(c.id);
  }
  if (hits.size === 0) return [];
  await db
    .update(intents)
    .set({ codeAttempts: sql`${intents.codeAttempts} - 1` })
    .where(
      inArray(
        intents.id,
        charged.map((c) => c.id),
      ),
    );
  return candidates.filter((c) => hits.has(c.id));
}

/**
 * Checks a code typed on a payment's web page. The legs of a split share one code and one count of tries,
 * as they do by text: a wrong guess on any leg's page costs every leg an attempt.
 */
export async function matchPageCode(db: Db, intent: Intent, code: string): Promise<boolean> {
  const candidates = intent.splitId ? await splitLegs(db, intent.splitId) : [intent];
  return (await matchCode(db, candidates, code)).length > 0;
}

export async function claimForSettlement(db: Db, id: string, now: Date): Promise<Intent | null> {
  const [row] = await db
    .update(intents)
    .set({ status: "settling", codeHash: null, approvedAt: now })
    .where(and(eq(intents.id, id), eq(intents.status, "pending"), gt(intents.expiresAt, now)))
    .returning();
  return row ?? null;
}

export async function claimEscrowForRelease(db: Db, id: string, now: Date): Promise<Intent | null> {
  const [row] = await db
    .update(intents)
    .set({ status: "settling", codeHash: null })
    .where(and(eq(intents.id, id), eq(intents.status, "escrowed"), gt(intents.escrowExpiresAt, now)))
    .returning();
  return row ?? null;
}

export async function claimEscrowForRefund(db: Db, id: string, now: Date): Promise<Intent | null> {
  const [row] = await db
    .update(intents)
    .set({ status: "settling", codeHash: null })
    .where(and(eq(intents.id, id), eq(intents.status, "escrowed"), lt(intents.escrowExpiresAt, now)))
    .returning();
  return row ?? null;
}

export async function declineIntent(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(intents)
    .set({ status: "declined", codeHash: null })
    .where(and(eq(intents.id, id), eq(intents.status, "pending")))
    .returning({ id: intents.id });
  return rows.length > 0;
}

export async function markSettled(
  db: Db,
  id: string,
  r: { txHash: string; explorerUrl: string },
  now = new Date(),
): Promise<void> {
  await db
    .update(intents)
    .set({ status: "settled", txHash: r.txHash, explorerUrl: r.explorerUrl, settledAt: now })
    .where(eq(intents.id, id));
}

export async function markEscrowed(
  db: Db,
  id: string,
  r: { txHash: string; explorerUrl: string },
  escrowExpiresAt: Date,
): Promise<void> {
  await db
    .update(intents)
    .set({ status: "escrowed", txHash: r.txHash, explorerUrl: r.explorerUrl, escrowExpiresAt })
    .where(eq(intents.id, id));
}

export async function markReleased(
  db: Db,
  id: string,
  status: "settled" | "refunded",
  r: { txHash: string; explorerUrl: string },
  now: Date,
): Promise<void> {
  await db
    .update(intents)
    .set({ status, releaseTxHash: r.txHash, releaseExplorerUrl: r.explorerUrl, settledAt: now })
    .where(eq(intents.id, id));
}

export async function revertToEscrowed(db: Db, id: string, error: string): Promise<void> {
  await db
    .update(intents)
    .set({ status: "escrowed", error: error.slice(0, 500) })
    .where(eq(intents.id, id));
}

/**
 * A settlement whose outcome isn't known yet (the money may have moved) stays "settling" with one of
 * these in `error`: waiting for the resume job, or taken by a resume run since the ISO time that
 * follows. A run that dies mid-retry leaves its marker, and the claim goes stale after RETRY_STALE_MS.
 */
const UNKNOWN = "outcome unknown: ";
const RETRYING = "outcome unknown, retrying since ";
const RETRY_STALE_MS = 5 * 60_000;

export async function markOutcomeUnknown(db: Db, id: string, error: string): Promise<void> {
  await db
    .update(intents)
    .set({ error: `${UNKNOWN}${error}`.slice(0, 500) })
    .where(and(eq(intents.id, id), eq(intents.status, "settling")));
}

/** Waiting for a retry, or taken by a run that started before `staleBefore` (and so likely died). */
function retryable(staleBefore: Date) {
  const isoLength = staleBefore.toISOString().length;
  return or(
    sql`${intents.error} like ${`${UNKNOWN}%`}`,
    and(
      sql`${intents.error} like ${`${RETRYING}%`}`,
      sql`substr(${intents.error}, 1, ${RETRYING.length + isoLength}) < ${`${RETRYING}${staleBefore.toISOString()}`}`,
    ),
  );
}

/** Settlements left with an unknown outcome, oldest first, for the resume job to drive to an answer. */
export async function unknownSettlements(db: Db, now: Date, limit = 10): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(and(eq(intents.status, "settling"), retryable(new Date(now.getTime() - RETRY_STALE_MS))))
    .orderBy(intents.createdAt)
    .limit(limit);
}

/** Takes one unknown settlement for a retry, so two resume runs never drive the same one at once. */
export async function claimUnknownForRetry(db: Db, id: string, now: Date): Promise<Intent | null> {
  const [row] = await db
    .update(intents)
    .set({ error: `${RETRYING}${now.toISOString()}` })
    .where(and(eq(intents.id, id), eq(intents.status, "settling"), retryable(new Date(now.getTime() - RETRY_STALE_MS))))
    .returning();
  return row ?? null;
}

/**
 * A transfer that went out without an answer (TransferUnconfirmedError) stays "settling" with this and its
 * transaction id in `error`, until reconcileTransfers learns from the chain whether it landed. Never sent again.
 */
const UNCONFIRMED_TRANSFER = "transfer unconfirmed: ";

export async function markTransferUnconfirmed(db: Db, id: string, txHash: string): Promise<void> {
  await db
    .update(intents)
    .set({ error: `${UNCONFIRMED_TRANSFER}${txHash}` })
    .where(and(eq(intents.id, id), eq(intents.status, "settling")));
}

/** The transaction an unconfirmed transfer is waiting on, or null when the intent isn't one. */
export function unconfirmedTransferTx(i: Pick<Intent, "status" | "error">): string | null {
  return i.status === "settling" && i.error?.startsWith(UNCONFIRMED_TRANSFER) ? i.error.slice(UNCONFIRMED_TRANSFER.length) : null;
}

/** Transfers waiting on the chain's answer, oldest first. */
export async function unconfirmedTransfers(db: Db, limit = 20): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(and(eq(intents.status, "settling"), sql`${intents.error} like ${`${UNCONFIRMED_TRANSFER}%`}`))
    .orderBy(intents.createdAt)
    .limit(limit);
}

/** Finishes an unconfirmed transfer, once: only the caller whose update lands acts on it. */
export async function finishUnconfirmedTransfer(
  db: Db,
  i: Pick<Intent, "id" | "error">,
  set:
    | { status: "settled"; txHash: string; explorerUrl: string; settledAt: Date }
    | { status: "escrowed"; txHash: string; explorerUrl: string; escrowExpiresAt: Date }
    | { status: "failed"; error: string },
): Promise<boolean> {
  if (!i.error?.startsWith(UNCONFIRMED_TRANSFER)) return false;
  const values = set.status === "failed" ? { ...set, codeHash: null } : { ...set, error: null };
  const rows = await db
    .update(intents)
    .set(values)
    .where(and(eq(intents.id, i.id), eq(intents.status, "settling"), eq(intents.error, i.error)))
    .returning({ id: intents.id });
  return rows.length > 0;
}

export async function markFailed(db: Db, id: string, error: string): Promise<void> {
  await db
    .update(intents)
    .set({ status: "failed", error: error.slice(0, 500), codeHash: null })
    .where(eq(intents.id, id));
}

/** Escrows still waiting for this person to claim them (not yet expired). */
export async function escrowedTo(db: Db, userId: string, now: Date): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(and(eq(intents.recipientId, userId), eq(intents.status, "escrowed"), gt(intents.escrowExpiresAt, now)))
    .orderBy(intents.createdAt);
}

export async function expiredEscrowsFrom(db: Db, userId: string, now: Date): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(and(eq(intents.senderId, userId), eq(intents.status, "escrowed"), lt(intents.escrowExpiresAt, now)));
}

export async function latestPendingRequestFor(db: Db, payerId: string, now: Date): Promise<Intent | null> {
  const [row] = await db
    .select()
    .from(intents)
    .where(
      and(
        eq(intents.senderId, payerId),
        eq(intents.status, "pending"),
        inArray(intents.kind, ["request", "invoice"]),
        gt(intents.expiresAt, now),
      ),
    )
    .orderBy(desc(intents.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * What a user has paid out since `since`: payments approved since then that are moving or moved. Counted
 * by when they were approved, not created, so a request made last week and paid today counts today. Stock
 * tokens have no price on testnet, so they don't count.
 */
export async function sentSince(db: Db, userId: string, since: Date): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string | null>`sum(${intents.amount})` })
    .from(intents)
    .where(
      and(
        eq(intents.senderId, userId),
        inArray(intents.status, ["settling", "escrowed", "settled"]),
        sql`coalesce(${intents.approvedAt}, ${intents.createdAt}) >= ${since.getTime()}`,
        notInArray(intents.token, [...STOCK_TOKEN_ADDRESSES]),
      ),
    );
  return BigInt(row?.total ?? 0);
}

export async function latestSettledTo(db: Db, userId: string): Promise<Intent | null> {
  const [row] = await db
    .select()
    .from(intents)
    .where(and(eq(intents.recipientId, userId), inArray(intents.status, ["settled", "escrowed"])))
    .orderBy(desc(intents.createdAt))
    .limit(1);
  return row ?? null;
}

/** An unapproved, unexpired intent that matches this one: the person asked twice. */
export async function findPendingDuplicate(
  db: Db,
  q: { senderId: string; recipientId: string; kind: IntentKind; amount: bigint; chain: Chain; token: string },
  now: Date,
): Promise<Intent | null> {
  const [row] = await db
    .select()
    .from(intents)
    .where(
      and(
        eq(intents.senderId, q.senderId),
        eq(intents.recipientId, q.recipientId),
        eq(intents.kind, q.kind),
        eq(intents.amount, q.amount),
        eq(intents.chain, q.chain),
        eq(intents.token, q.token),
        eq(intents.status, "pending"),
        gt(intents.expiresAt, now),
        // A share of a split is not the same payment as a send of that amount.
        isNull(intents.splitId),
      ),
    )
    .orderBy(desc(intents.createdAt))
    .limit(1);
  return row ?? null;
}

/** The same payment already went out moments ago. */
export async function findRecentCompletedDuplicate(
  db: Db,
  q: { senderId: string; recipientId: string; amount: bigint; chain: Chain; token: string },
  since: Date,
): Promise<Intent | null> {
  const [row] = await db
    .select()
    .from(intents)
    .where(
      and(
        eq(intents.senderId, q.senderId),
        eq(intents.recipientId, q.recipientId),
        eq(intents.amount, q.amount),
        eq(intents.chain, q.chain),
        eq(intents.token, q.token),
        eq(intents.kind, "send"),
        inArray(intents.status, ["settling", "settled", "escrowed"]),
        gte(intents.createdAt, since),
        isNull(intents.splitId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Does this code belong to one of the user's payments that has already expired? */
/** A claim code for an escrow that has since expired: the escrow, so the reply can say what happened to it. */
export async function expiredEscrowForCode(db: Db, userId: string, code: string, now: Date): Promise<Intent | null> {
  const expired = await db
    .select()
    .from(intents)
    .where(
      and(
        eq(intents.recipientId, userId),
        eq(intents.status, "escrowed"),
        lte(intents.escrowExpiresAt, now),
        isNotNull(intents.codeHash),
      ),
    );
  for (const i of expired) if (i.codeHash === (await hashCode(i.id, code))) return i;
  return null;
}

/** Funding an escrow was sent but not confirmed: it stays "settling" with the error until the chain says. */
export async function markFundingUnconfirmed(db: Db, id: string, error: string): Promise<void> {
  await db
    .update(intents)
    .set({ error: error.slice(0, 500) })
    .where(and(eq(intents.id, id), eq(intents.status, "settling")));
}

/** Finishes an unconfirmed funding, once: only the caller whose update lands acts on it. */
export async function settleUnconfirmed(
  db: Db,
  id: string,
  set:
    | { status: "escrowed"; txHash: string; explorerUrl: string; escrowExpiresAt: Date }
    | { status: "failed"; error: string },
): Promise<boolean> {
  const values = set.status === "escrowed" ? { ...set, error: null } : { ...set, codeHash: null };
  const rows = await db
    .update(intents)
    .set(values)
    .where(and(eq(intents.id, id), eq(intents.status, "settling"), isNull(intents.txHash)))
    .returning({ id: intents.id });
  return rows.length > 0;
}

/**
 * Program escrows whose funding we couldn't confirm: marked unconfirmed, or still "settling" with no
 * funding transaction long after approval (the worker died mid-send). Settled from the chain by
 * `reconcileEscrows`.
 */
export async function unconfirmedEscrowFunding(db: Db, staleBefore: Date): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(
      and(
        eq(intents.status, "settling"),
        isNotNull(intents.escrowProgram),
        isNull(intents.txHash),
        or(isNotNull(intents.error), lt(intents.approvedAt, staleBefore)),
      ),
    );
}

export async function matchesExpiredCode(db: Db, userId: string, code: string, now: Date): Promise<boolean> {
  const expired = await db
    .select()
    .from(intents)
    .where(and(eq(intents.senderId, userId), eq(intents.status, "pending"), lt(intents.expiresAt, now), isNotNull(intents.codeHash)));
  for (const i of expired) if (i.codeHash === (await hashCode(i.id, code))) return true;
  return false;
}

export async function hasAwaitingApproval(db: Db, userId: string, now: Date): Promise<boolean> {
  return (await codeCandidates(db, userId, now)).length > 0;
}

/** Cancels everything the user started but never approved. Returns how many were cancelled. */
export async function cancelUnapproved(db: Db, userId: string, now: Date): Promise<number> {
  const rows = await db
    .update(intents)
    .set({ status: "declined", codeHash: null })
    .where(
      and(
        eq(intents.createdBy, userId),
        eq(intents.senderId, userId),
        eq(intents.status, "pending"),
        gt(intents.expiresAt, now),
      ),
    )
    .returning({ id: intents.id });
  return rows.length;
}

/** Requests and invoices waiting on this payer. */
export async function pendingRequestsFor(db: Db, payerId: string, now: Date): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(
      and(
        eq(intents.senderId, payerId),
        eq(intents.status, "pending"),
        inArray(intents.kind, ["request", "invoice"]),
        gt(intents.expiresAt, now),
      ),
    )
    .orderBy(intents.createdAt)
    .limit(3);
}

/** The user has a live payment whose code was locked by too many wrong tries. */
export async function hasLockedCode(db: Db, userId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: intents.id })
    .from(intents)
    .where(
      and(
        eq(intents.senderId, userId),
        eq(intents.status, "pending"),
        gt(intents.expiresAt, now),
        isNotNull(intents.codeHash),
        gte(intents.codeAttempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The user's newest payment since `since` that is still waiting on them or still moving: one they pay
 * (unexpired and pending, or settling), or an escrow waiting for them to claim.
 */
export async function latestInFlightFor(db: Db, userId: string, since: Date, now: Date): Promise<Intent | null> {
  const [row] = await db
    .select()
    .from(intents)
    .where(
      and(
        gte(intents.createdAt, since),
        or(
          and(
            eq(intents.senderId, userId),
            or(eq(intents.status, "settling"), and(eq(intents.status, "pending"), gt(intents.expiresAt, now))),
          ),
          and(eq(intents.recipientId, userId), eq(intents.status, "escrowed")),
        ),
      ),
    )
    .orderBy(desc(intents.createdAt))
    .limit(1);
  return row ?? null;
}

/** Payments a user is part of (paying, being paid, or asked for), newest first. */
export async function intentsFor(db: Db, userId: string, limit: number): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(or(eq(intents.senderId, userId), eq(intents.recipientId, userId), eq(intents.createdBy, userId)))
    .orderBy(desc(intents.createdAt))
    .limit(limit);
}

export function newSplitId(): string {
  return newId("sp");
}

/** Every leg of a split, in the order the sender listed the people. */
export async function splitLegs(db: Db, splitId: string): Promise<Intent[]> {
  return db.select().from(intents).where(eq(intents.splitId, splitId)).orderBy(sql`rowid`);
}

/** Hash over every leg of a split, so one passkey approval covers exactly these payments. */
export async function splitHash(legs: Intent[]): Promise<string> {
  const each = await Promise.all(legs.map((l) => intentHash(l)));
  return sha256Hex(JSON.stringify(["dial-split-v1", legs[0]?.splitId ?? null, ...each]));
}

/**
 * Moves every pending, unexpired leg of a split to "settling" in one statement, so a split is approved whole.
 * Returns the legs it moved; fewer than the split has means some leg was already cancelled or used.
 */
export async function claimSplitForSettlement(db: Db, splitId: string, now: Date): Promise<Intent[]> {
  return db
    .update(intents)
    .set({ status: "settling", codeHash: null, approvedAt: now })
    .where(and(eq(intents.splitId, splitId), eq(intents.status, "pending"), gt(intents.expiresAt, now)))
    .returning();
}

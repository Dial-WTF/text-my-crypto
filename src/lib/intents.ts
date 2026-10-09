import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import { hashCode, MAX_CODE_ATTEMPTS, newCode } from "@/lib/codes";
import type { Db } from "@/lib/db/client";
import { type Intent, intents } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/hash";
import { newId, randomToken } from "@/lib/ids";

export const SEND_TTL_MS = 10 * 60_000;
export const REQUEST_TTL_MS = 7 * 24 * 60 * 60_000;

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
  /** Preset when something keyed by the id (an escrow vault) has to be known before the row exists. */
  id?: string;
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

/** Finds the candidate whose code matches; on a miss, burns an attempt on every candidate. */
export async function matchCode(db: Db, candidates: Intent[], code: string): Promise<Intent[]> {
  const matches: Intent[] = [];
  for (const c of candidates) {
    if (c.codeHash && c.codeHash === (await hashCode(c.id, code))) matches.push(c);
  }
  if (matches.length === 0 && candidates.length > 0) {
    await db
      .update(intents)
      .set({ codeAttempts: sql`${intents.codeAttempts} + 1` })
      .where(
        inArray(
          intents.id,
          candidates.map((c) => c.id),
        ),
      );
  }
  return matches;
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

export async function sentSince(db: Db, userId: string, since: Date): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string | null>`sum(${intents.amount})` })
    .from(intents)
    .where(
      and(
        eq(intents.senderId, userId),
        inArray(intents.status, ["settling", "escrowed", "settled"]),
        gte(intents.createdAt, since),
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
  q: { senderId: string; recipientId: string; kind: IntentKind; amount: bigint; chain: Chain },
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
        eq(intents.status, "pending"),
        gt(intents.expiresAt, now),
      ),
    )
    .orderBy(desc(intents.createdAt))
    .limit(1);
  return row ?? null;
}

/** The same payment already went out moments ago. */
export async function findRecentCompletedDuplicate(
  db: Db,
  q: { senderId: string; recipientId: string; amount: bigint; chain: Chain },
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
        eq(intents.kind, "send"),
        inArray(intents.status, ["settling", "settled", "escrowed"]),
        gte(intents.createdAt, since),
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

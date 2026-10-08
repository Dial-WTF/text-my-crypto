import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { smsLog } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { InboundSms } from "./inbound";
import { INBOUND_LEASE_MS } from "./lease";

/**
 * Records an inbound text and says whether the caller should handle it.
 * Without a claim, only the first delivery is handled. With a claim (from claimInbound), the
 * claim holder handles it until it is marked handled.
 */
export async function logInbound(db: Db, msg: InboundSms): Promise<boolean> {
  const rows = await db
    .insert(smsLog)
    .values({ id: newId("sms"), direction: "in", phone: msg.from, body: msg.body, dedupeKey: msg.dedupeKey })
    .onConflictDoNothing({ target: smsLog.dedupeKey })
    .returning({ id: smsLog.id });
  if (rows.length > 0) return true;
  if (!msg.claim) return false;
  const mine = await db
    .select({ id: smsLog.id })
    .from(smsLog)
    .where(and(eq(smsLog.dedupeKey, msg.dedupeKey), eq(smsLog.claimId, msg.claim), isNull(smsLog.handledAt)))
    .limit(1);
  return mine.length > 0;
}

export type InboundClaim = { kind: "claimed"; claimId: string } | { kind: "handled" } | { kind: "busy" };

/**
 * Takes the claim on an inbound text before handling it. Claims a new message, or an unhandled one
 * whose previous claim was released or went stale (a crashed attempt). Reports "handled" when it
 * was already fully handled and "busy" when another attempt holds a live claim.
 */
export async function claimInbound(db: Db, msg: InboundSms, now: Date): Promise<InboundClaim> {
  const claimId = newId("clm");
  const inserted = await db
    .insert(smsLog)
    .values({
      id: newId("sms"),
      direction: "in",
      phone: msg.from,
      body: msg.body,
      dedupeKey: msg.dedupeKey,
      claimId,
      claimedAt: now,
    })
    .onConflictDoNothing({ target: smsLog.dedupeKey })
    .returning({ id: smsLog.id });
  if (inserted.length > 0) return { kind: "claimed", claimId };

  const staleBefore = new Date(now.getTime() - INBOUND_LEASE_MS);
  const taken = await db
    .update(smsLog)
    .set({ claimId, claimedAt: now })
    .where(
      and(
        eq(smsLog.dedupeKey, msg.dedupeKey),
        isNull(smsLog.handledAt),
        or(isNull(smsLog.claimedAt), lte(smsLog.claimedAt, staleBefore)),
      ),
    )
    .returning({ id: smsLog.id });
  if (taken.length > 0) return { kind: "claimed", claimId };

  const [row] = await db
    .select({ handledAt: smsLog.handledAt })
    .from(smsLog)
    .where(eq(smsLog.dedupeKey, msg.dedupeKey))
    .limit(1);
  return row?.handledAt ? { kind: "handled" } : { kind: "busy" };
}

/** Marks a claimed inbound text as fully handled so later deliveries skip it. */
export async function finishInbound(db: Db, dedupeKey: string, claimId: string, now: Date): Promise<void> {
  await db
    .update(smsLog)
    .set({ handledAt: now })
    .where(and(eq(smsLog.dedupeKey, dedupeKey), eq(smsLog.claimId, claimId)));
}

/** Gives up a claim after a failed attempt so the next delivery can retry right away. */
export async function releaseInbound(db: Db, dedupeKey: string, claimId: string): Promise<void> {
  await db
    .update(smsLog)
    .set({ claimId: null, claimedAt: null })
    .where(and(eq(smsLog.dedupeKey, dedupeKey), eq(smsLog.claimId, claimId), isNull(smsLog.handledAt)));
}

export async function logOutbound(db: Db, phone: string, body: string): Promise<void> {
  await db.insert(smsLog).values({ id: newId("sms"), direction: "out", phone, body });
}

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { smsLog } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { InboundSms } from "./inbound";

/** Records an inbound text. Returns its log id, or null if this exact delivery was already seen. */
export async function logInbound(db: Db, msg: InboundSms, now = new Date()): Promise<string | null> {
  const id = newId("sms");
  const rows = await db
    .insert(smsLog)
    .values({ id, direction: "in", phone: msg.from, body: msg.body, dedupeKey: msg.dedupeKey, createdAt: now })
    .onConflictDoNothing({ target: smsLog.dedupeKey })
    .returning({ id: smsLog.id });
  return rows.length > 0 ? id : null;
}

export async function logOutbound(db: Db, phone: string, body: string, now = new Date()): Promise<void> {
  await db.insert(smsLog).values({ id: newId("sms"), direction: "out", phone, body, createdAt: now });
}

/** Insertion order. Timestamps can tie; SQLite's rowid never does. */
const inserted = sql`rowid`;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * A double-tap: the previous message in this conversation (either direction) is the same text from the
 * same phone, inside the window, with no reply from the operator in between. If the operator answered
 * in between, a repeat is deliberate and gets handled like any other text.
 */
export async function isBurstRepeat(db: Db, logId: string, phone: string, body: string, since: Date): Promise<boolean> {
  const [previous] = await db
    .select({ direction: smsLog.direction, body: smsLog.body, createdAt: smsLog.createdAt })
    .from(smsLog)
    .where(and(eq(smsLog.phone, phone), sql`rowid < (select rowid from sms_log where id = ${logId})`))
    .orderBy(desc(inserted))
    .limit(1);
  return Boolean(previous && previous.direction === "in" && previous.createdAt >= since && norm(previous.body) === norm(body));
}

/** The last few lines of the conversation, oldest first, for conversational replies. */
export async function recentHistory(db: Db, phone: string, limit = 6): Promise<string[]> {
  const rows = await db
    .select({ direction: smsLog.direction, body: smsLog.body })
    .from(smsLog)
    .where(eq(smsLog.phone, phone))
    .orderBy(desc(inserted))
    .limit(limit);
  return rows.reverse().map((r) => `${r.direction === "in" ? "them" : "operator"}: ${r.body.slice(0, 200)}`);
}

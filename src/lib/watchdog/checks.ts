import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { smsLog } from "@/lib/db/schema";
import { normalizePhone } from "@/lib/phone";

/** How long a text may wait for its first reply before it counts as unanswered. */
const UNANSWERED_AFTER_MS = 60_000;
/** How long Payphone may hold a text before it counts as never delivered to the webhook. */
const MISSING_AFTER_MS = 2 * 60_000;
/** Both checks alert on this far back. Older items drop out instead of alerting forever. */
export const LOOKBACK_MS = 60 * 60_000;
/** How far back the runner looks for items that aged out of the lookback, so it can say so instead of "Cleared". */
export const AGED_LOOKBACK_MS = 24 * 60 * 60_000;

/** A phone number reduced to its last four digits, the most any alert or log line shows. */
const tail = (phone: string) => `…${phone.replace(/\D/g, "").slice(-4)}`;

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))}m`;

export type Unanswered = { id: string; phone: string; createdAt: Date };

/**
 * Inbound texts older than a minute (and inside the lookback) that were never marked handled and got
 * no outbound text to the same phone after them. Handled texts the bot chose not to answer (STOP,
 * double-taps) have handled_at set; a text still mid-payment already got "Sending…".
 */
export async function findUnanswered(db: Db, now: Date, lookbackMs = LOOKBACK_MS): Promise<Unanswered[]> {
  const cutoff = new Date(now.getTime() - UNANSWERED_AFTER_MS);
  const since = new Date(now.getTime() - lookbackMs);
  return db
    .select({ id: smsLog.id, phone: smsLog.phone, createdAt: smsLog.createdAt })
    .from(smsLog)
    .where(
      and(
        eq(smsLog.direction, "in"),
        isNull(smsLog.handledAt),
        gte(smsLog.createdAt, since),
        lte(smsLog.createdAt, cutoff),
        sql`not exists (select 1 from sms_log o where o.direction = 'out' and o.phone = ${smsLog.phone} and o.rowid > sms_log.rowid)`,
      ),
    )
    .orderBy(smsLog.createdAt);
}

export function describeUnanswered(rows: Unanswered[], now: Date): string {
  const oldest = rows[0];
  if (!oldest) return "none";
  const phones = [...new Set(rows.map((r) => tail(r.phone)))].join(", ");
  return `${rows.length} text${rows.length === 1 ? "" : "s"} with no reply, oldest ${minutes(now.getTime() - oldest.createdAt.getTime())} (${phones})`;
}

const inboxSchema = z.object({
  messages: z.array(
    z.object({
      direction: z.string(),
      contact: z.string(),
      body: z.string(),
      timestamp: z.string(),
    }),
  ),
});

export type InboxText = { phone: string; body: string; at: Date };

/**
 * The operator line's recent inbound texts as Payphone has them. Contacts can carry a gateway suffix
 * ("+1…@cheogram.com"); they are normalized the same way the webhook normalizes senders.
 */
export async function fetchPayphoneInbox(
  cfg: { baseUrl: string; apiKey: string; line: string },
  fetchImpl: typeof fetch = fetch,
): Promise<InboxText[]> {
  const url = `${cfg.baseUrl}/api/v1/sms/inbox?phone=${encodeURIComponent(cfg.line)}&limit=200`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${cfg.apiKey}` } });
  if (!res.ok) throw new Error(`Payphone inbox HTTP ${res.status}`);
  const parsed = inboxSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error("Payphone inbox answered an unexpected shape");
  return parsed.data.messages.flatMap((m) => {
    const phone = normalizePhone(m.contact.replace(/@.*$/, ""));
    const at = new Date(m.timestamp);
    if (m.direction !== "inbound" || !phone || Number.isNaN(at.getTime())) return [];
    return [{ phone, body: m.body.trim(), at }];
  });
}

/** Payphone may log a text a moment before or after our row; ours normally lands 1–10s later. */
const EARLY_SLACK_MS = 60_000;

/**
 * Inbound texts Payphone received more than two minutes ago (inside the lookback) that never reached
 * sms_log. Matched on phone and body, each log row used once, so a repeated text counts twice.
 */
export async function findMissing(db: Db, inbox: InboxText[], now: Date, lookbackMs = LOOKBACK_MS): Promise<InboxText[]> {
  const since = new Date(now.getTime() - lookbackMs);
  const due = inbox
    .filter((m) => m.at >= since && now.getTime() - m.at.getTime() >= MISSING_AFTER_MS)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (due.length === 0) return [];
  const rows = await db
    .select({ phone: smsLog.phone, body: smsLog.body, createdAt: smsLog.createdAt })
    .from(smsLog)
    .where(and(eq(smsLog.direction, "in"), gte(smsLog.createdAt, new Date(since.getTime() - EARLY_SLACK_MS))))
    .orderBy(smsLog.createdAt);
  const used = new Set<number>();
  return due.filter((m) => {
    const i = rows.findIndex(
      (r, j) =>
        !used.has(j) &&
        r.phone === m.phone &&
        r.body === m.body &&
        r.createdAt.getTime() >= m.at.getTime() - EARLY_SLACK_MS,
    );
    if (i === -1) return true;
    used.add(i);
    return false;
  });
}

export function describeMissing(texts: InboxText[], now: Date): string {
  const oldest = texts[0];
  if (!oldest) return "none";
  const phones = [...new Set(texts.map((t) => tail(t.phone)))].join(", ");
  return `${texts.length} text${texts.length === 1 ? "" : "s"} in Payphone never reached Dial, oldest ${minutes(now.getTime() - oldest.at.getTime())} (${phones})`;
}

import type { Db } from "@/lib/db/client";
import { smsLog } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { InboundSms } from "./inbound";

export async function logInbound(db: Db, msg: InboundSms): Promise<boolean> {
  const rows = await db
    .insert(smsLog)
    .values({ id: newId("sms"), direction: "in", phone: msg.from, body: msg.body, dedupeKey: msg.dedupeKey })
    .onConflictDoNothing({ target: smsLog.dedupeKey })
    .returning({ id: smsLog.id });
  return rows.length > 0;
}

export async function logOutbound(db: Db, phone: string, body: string): Promise<void> {
  await db.insert(smsLog).values({ id: newId("sms"), direction: "out", phone, body });
}

import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { smsOptOuts } from "@/lib/db/schema";

export async function isOptedOut(db: Db, phone: string): Promise<boolean> {
  const [row] = await db.select().from(smsOptOuts).where(eq(smsOptOuts.phone, phone)).limit(1);
  return Boolean(row);
}

export async function optOut(db: Db, phone: string, now: Date): Promise<void> {
  await db.insert(smsOptOuts).values({ phone, optedOutAt: now }).onConflictDoNothing({ target: smsOptOuts.phone });
}

export async function optIn(db: Db, phone: string): Promise<void> {
  await db.delete(smsOptOuts).where(eq(smsOptOuts.phone, phone));
}

import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { type Contact, contacts } from "@/lib/db/schema";

export async function saveContact(db: Db, ownerId: string, name: string, phone: string): Promise<void> {
  await db
    .insert(contacts)
    .values({ ownerId, name: name.toLowerCase(), phone })
    .onConflictDoUpdate({ target: [contacts.ownerId, contacts.name], set: { phone } });
}

export async function findContact(db: Db, ownerId: string, name: string): Promise<Contact | null> {
  const [c] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.ownerId, ownerId), eq(contacts.name, name.toLowerCase())))
    .limit(1);
  return c ?? null;
}

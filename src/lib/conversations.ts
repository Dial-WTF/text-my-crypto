import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { conversations } from "@/lib/db/schema";

export const CONVERSATION_TTL_MS = 15 * 60_000;

const conversationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("awaiting_name"), payload: z.object({}).strict() }),
  z.object({ state: z.literal("awaiting_number"), payload: z.object({ name: z.string(), command: z.string() }) }),
  z.object({ state: z.literal("awaiting_duplicate"), payload: z.object({ command: z.string() }) }),
  z.object({
    state: z.literal("awaiting_choice"),
    payload: z.object({ name: z.string(), command: z.string(), handles: z.array(z.string()).min(2).max(5) }),
  }),
]);

export type Conversation = z.infer<typeof conversationSchema>;

export async function getConversation(db: Db, phone: string, now: Date): Promise<Conversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.phone, phone), gt(conversations.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  const parsed = conversationSchema.safeParse({ state: row.state, payload: JSON.parse(row.payload) });
  return parsed.success ? parsed.data : null;
}

export async function setConversation(db: Db, phone: string, c: Conversation, now: Date): Promise<void> {
  const values = {
    phone,
    state: c.state,
    payload: JSON.stringify(c.payload),
    expiresAt: new Date(now.getTime() + CONVERSATION_TTL_MS),
  };
  await db
    .insert(conversations)
    .values(values)
    .onConflictDoUpdate({ target: conversations.phone, set: values });
}

export async function clearConversation(db: Db, phone: string): Promise<void> {
  await db.delete(conversations).where(eq(conversations.phone, phone));
}

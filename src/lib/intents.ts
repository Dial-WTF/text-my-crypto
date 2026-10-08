import { and, desc, eq, gt } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
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
  amount: bigint;
  note: string | null;
};

type Bound = Pick<
  Intent,
  "id" | "kind" | "senderId" | "chain" | "token" | "recipientAddress" | "amount" | "nonce" | "expiresAt"
>;

export function canonicalIntent(i: Bound): string {
  return JSON.stringify([
    "dial-intent-v1",
    i.id,
    i.kind,
    i.senderId,
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

export async function createIntent(db: Db, n: NewIntent, now: Date): Promise<Intent> {
  const ttl = n.kind === "send" ? SEND_TTL_MS : REQUEST_TTL_MS;
  const [row] = await db
    .insert(intents)
    .values({ ...n, id: newId("pi"), nonce: randomToken(16), expiresAt: new Date(now.getTime() + ttl) })
    .returning();
  if (!row) throw new Error("createIntent returned no row");
  return row;
}

export async function getIntent(db: Db, id: string): Promise<Intent | null> {
  const [row] = await db.select().from(intents).where(eq(intents.id, id)).limit(1);
  return row ?? null;
}

export async function claimForSettlement(db: Db, id: string, now: Date): Promise<Intent | null> {
  const [row] = await db
    .update(intents)
    .set({ status: "settling" })
    .where(and(eq(intents.id, id), eq(intents.status, "pending"), gt(intents.expiresAt, now)))
    .returning();
  return row ?? null;
}

export async function declineIntent(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(intents)
    .set({ status: "declined" })
    .where(and(eq(intents.id, id), eq(intents.status, "pending")))
    .returning({ id: intents.id });
  return rows.length > 0;
}

export async function markSettled(db: Db, id: string, r: { txHash: string; explorerUrl: string }): Promise<void> {
  await db
    .update(intents)
    .set({ status: "settled", txHash: r.txHash, explorerUrl: r.explorerUrl })
    .where(eq(intents.id, id));
}

export async function markFailed(db: Db, id: string, error: string): Promise<void> {
  await db
    .update(intents)
    .set({ status: "failed", error: error.slice(0, 500) })
    .where(eq(intents.id, id));
}

export async function latestSettledTo(db: Db, userId: string): Promise<Intent | null> {
  const [row] = await db
    .select()
    .from(intents)
    .where(and(eq(intents.recipientId, userId), eq(intents.status, "settled")))
    .orderBy(desc(intents.createdAt))
    .limit(1);
  return row ?? null;
}

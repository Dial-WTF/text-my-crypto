import { sql } from "drizzle-orm";
import { customType, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { CHAINS } from "@/lib/chains";

/** Token amounts in base units. SQLite INTEGER is 64-bit; the app works in bigint. */
const amount = customType<{ data: bigint; driverData: number | bigint }>({
  dataType: () => "integer",
  toDriver: (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v),
  fromDriver: (v) => BigInt(v),
});

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const now = sql`(unixepoch('subsec') * 1000)`;

const INTENT_KINDS = ["send", "request", "invoice", "withdraw"] as const;
const INTENT_STATUSES = ["pending", "settling", "escrowed", "settled", "refunded", "failed", "declined"] as const;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  handle: text("handle").unique(),
  name: text("name"),
  claimedAt: ts("claimed_at"),
  defaultChain: text("default_chain", { enum: CHAINS }).notNull().default("solana"),
  createdAt: ts("created_at").notNull().default(now),
});

export const wallets = sqliteTable(
  "wallets",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    chain: text("chain", { enum: CHAINS }).notNull(),
    address: text("address").notNull(),
    secretEnc: text("secret_enc").notNull(),
  },
  (t) => [uniqueIndex("wallets_user_chain").on(t.userId, t.chain)],
);

export const contacts = sqliteTable(
  "contacts",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    createdAt: ts("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.name] })],
);

export const conversations = sqliteTable("conversations", {
  phone: text("phone").primaryKey(),
  state: text("state", { enum: ["awaiting_name", "awaiting_number", "awaiting_choice"] }).notNull(),
  payload: text("payload").notNull().default("{}"),
  expiresAt: ts("expires_at").notNull(),
});

export const signupTokens = sqliteTable("signup_tokens", {
  token: text("token").primaryKey(),
  phone: text("phone").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  challenge: text("challenge"),
});

export const passkeys = sqliteTable("passkeys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: text("transports").notNull().default("[]"),
  createdAt: ts("created_at").notNull().default(now),
});

export const intents = sqliteTable("intents", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: INTENT_KINDS }).notNull().default("send"),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  note: text("note"),
  senderId: text("sender_id")
    .notNull()
    .references(() => users.id),
  recipientId: text("recipient_id")
    .notNull()
    .references(() => users.id),
  chain: text("chain", { enum: CHAINS }).notNull(),
  token: text("token").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  amount: amount("amount").notNull(),
  nonce: text("nonce").notNull(),
  expiresAt: ts("expires_at").notNull(),
  status: text("status", { enum: INTENT_STATUSES }).notNull().default("pending"),
  codeHash: text("code_hash"),
  codeAttempts: integer("code_attempts").notNull().default(0),
  escrowSecretEnc: text("escrow_secret_enc"),
  escrowExpiresAt: ts("escrow_expires_at"),
  txHash: text("tx_hash"),
  explorerUrl: text("explorer_url"),
  releaseTxHash: text("release_tx_hash"),
  releaseExplorerUrl: text("release_explorer_url"),
  error: text("error"),
  createdAt: ts("created_at").notNull().default(now),
  settledAt: ts("settled_at"),
});

export const smsLog = sqliteTable("sms_log", {
  id: text("id").primaryKey(),
  direction: text("direction", { enum: ["in", "out"] }).notNull(),
  phone: text("phone").notNull(),
  body: text("body").notNull(),
  dedupeKey: text("dedupe_key").unique(),
  createdAt: ts("created_at").notNull().default(now),
});

export type User = typeof users.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Intent = typeof intents.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Passkey = typeof passkeys.$inferSelect;

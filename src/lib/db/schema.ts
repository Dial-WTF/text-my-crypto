import { bigint, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { CHAINS } from "@/lib/chains";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const chainEnum = pgEnum("chain", CHAINS);
export const intentStatus = pgEnum("intent_status", ["pending", "settling", "settled", "failed"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  handle: text("handle").notNull().unique(),
  defaultChain: chainEnum("default_chain").notNull().default("solana"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const wallets = pgTable(
  "wallets",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    chain: chainEnum("chain").notNull(),
    address: text("address").notNull(),
    secretEnc: text("secret_enc").notNull(),
  },
  (t) => [uniqueIndex("wallets_user_chain").on(t.userId, t.chain)],
);

export const signupTokens = pgTable("signup_tokens", {
  token: text("token").primaryKey(),
  phone: text("phone").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const intents = pgTable("intents", {
  id: text("id").primaryKey(),
  senderId: text("sender_id")
    .notNull()
    .references(() => users.id),
  recipientId: text("recipient_id")
    .notNull()
    .references(() => users.id),
  chain: chainEnum("chain").notNull(),
  token: text("token").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  nonce: text("nonce").notNull(),
  expiresAt: ts("expires_at").notNull(),
  status: intentStatus("status").notNull().default("pending"),
  txHash: text("tx_hash"),
  explorerUrl: text("explorer_url"),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const smsLog = pgTable("sms_log", {
  id: text("id").primaryKey(),
  direction: text("direction", { enum: ["in", "out"] }).notNull(),
  phone: text("phone").notNull(),
  body: text("body").notNull(),
  dedupeKey: text("dedupe_key").unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Intent = typeof intents.$inferSelect;

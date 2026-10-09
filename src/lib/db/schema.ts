import { sql } from "drizzle-orm";
import { customType, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { CHAINS } from "@/lib/chains";

/** Token amounts in base units. SQLite INTEGER is 64-bit; the app works in bigint. */
const amount = customType<{ data: bigint; driverData: number | bigint }>({
  dataType: () => "integer",
  toDriver: (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v),
  fromDriver: (v) => BigInt(v),
});

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const now = sql`(unixepoch('subsec') * 1000)`;

/** "venue": a send (or a move of your own) from a HyperEVM wallet into a HyperCore spot balance. */
const INTENT_KINDS = ["send", "request", "invoice", "withdraw", "venue"] as const;
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
    /** When the test-funds drip landed. Null until it succeeds, so a drip that failed is retried. */
    drippedAt: ts("dripped_at"),
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
  state: text("state", { enum: ["awaiting_name", "awaiting_number", "awaiting_choice", "awaiting_duplicate", "awaiting_chain"] }).notNull(),
  payload: text("payload").notNull().default("{}"),
  expiresAt: ts("expires_at").notNull(),
});

export const signupTokens = sqliteTable("signup_tokens", {
  token: text("token").primaryKey(),
  phone: text("phone").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  challenge: text("challenge"),
  /** The code texted with the link. A link alone can't add a passkey: it has to be opened with the code. */
  codeHash: text("code_hash"),
  codeAttempts: integer("code_attempts").notNull().default(0),
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
  /** The ENS name or Basename a withdrawal was addressed to, kept for display. recipientAddress is what was resolved and approved. */
  recipientName: text("recipient_name"),
  amount: amount("amount").notNull(),
  nonce: text("nonce").notNull(),
  expiresAt: ts("expires_at").notNull(),
  status: text("status", { enum: INTENT_STATUSES }).notNull().default("pending"),
  codeHash: text("code_hash"),
  codeAttempts: integer("code_attempts").notNull().default(0),
  escrowSecretEnc: text("escrow_secret_enc"),
  /** Set when the escrow lives in an on-chain program (this program id) instead of a server-held wallet. */
  escrowProgram: text("escrow_program"),
  escrowExpiresAt: ts("escrow_expires_at"),
  /** When the approved payment started moving (status "settling"). The reconciler times unconfirmed sends from here. */
  approvedAt: ts("approved_at"),
  /** "send … privately": a shielded Zcash send. Public pages show it as shielded, with no amount, names or note. */
  private: integer("private", { mode: "boolean" }).notNull().default(false),
  txHash: text("tx_hash"),
  explorerUrl: text("explorer_url"),
  releaseTxHash: text("release_tx_hash"),
  releaseExplorerUrl: text("release_explorer_url"),
  error: text("error"),
  createdAt: ts("created_at").notNull().default(now),
  settledAt: ts("settled_at"),
  /** Legs of one split share this id: one code approves them all, and they settle in one transaction. */
  splitId: text("split_id"),
}, (t) => [index("intents_split").on(t.splitId)]);

/** Numbers that texted STOP. Nothing is sent to them until they text START. */
export const smsOptOuts = sqliteTable("sms_opt_outs", {
  phone: text("phone").primaryKey(),
  optedOutAt: ts("opted_out_at").notNull(),
});

export const smsLog = sqliteTable("sms_log", {
  id: text("id").primaryKey(),
  direction: text("direction", { enum: ["in", "out"] }).notNull(),
  phone: text("phone").notNull(),
  body: text("body").notNull(),
  dedupeKey: text("dedupe_key").unique(),
  /** Inbound only: who is processing it right now, and since when. A stale claim can be taken over. */
  claimId: text("claim_id"),
  claimedAt: ts("claimed_at"),
  /** Inbound only: set once the message was fully handled, so redelivery can skip it. */
  handledAt: ts("handled_at"),
  createdAt: ts("created_at").notNull().default(now),
});

/** Bearer keys for the MCP server. Only the SHA-256 of a key is stored; the key itself is shown once. */
export const agentKeys = sqliteTable("agent_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  keyHash: text("key_hash").notNull().unique(),
  label: text("label").notNull(),
  createdAt: ts("created_at").notNull().default(now),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
});

/** One-time links texted after "connect agent". Redeemed with the code from the same text to mint a key. */
export const agentLinks = sqliteTable("agent_links", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  label: text("label").notNull(),
  codeHash: text("code_hash").notNull(),
  codeAttempts: integer("code_attempts").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

/** One-time sign-in links texted after "wallet". Redeemed with the code from the same text to start a web session. */
export const loginLinks = sqliteTable("login_links", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  codeHash: text("code_hash").notNull(),
  codeAttempts: integer("code_attempts").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

/** Signed-in wallet page sessions. The cookie holds the token; only its hash is stored. */
export const webSessions = sqliteTable("web_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  via: text("via", { enum: ["text", "passkey"] }).notNull(),
  createdAt: ts("created_at").notNull().default(now),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
});

/**
 * Passkey sign-in challenges the wallet page handed out. Each is used once and lives five minutes.
 * The browser's cookie holds an opaque id; only its hash is stored. Payment approvals don't use this
 * table: their challenge is the intent hash.
 */
export const passkeyChallenges = sqliteTable("passkey_challenges", {
  idHash: text("id_hash").primaryKey(),
  purpose: text("purpose", { enum: ["login"] }).notNull(),
  challenge: text("challenge").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

/** Fixed-window call counters per agent key and bucket. */
export const agentRate = sqliteTable(
  "agent_rate",
  {
    keyId: text("key_id")
      .notNull()
      .references(() => agentKeys.id),
    bucket: text("bucket").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.bucket] })],
);

/**
 * The watchdog's problems, one row per check, kept after they resolve so the 30-minute alert window
 * survives a check that flaps. Open while `resolvedAt` is null.
 */
export const watchdogProblems = sqliteTable("watchdog_problems", {
  key: text("key").primaryKey(),
  detail: text("detail").notNull(),
  /** Consecutive failing runs; some checks wait for a second failure before alerting. */
  failures: integer("failures").notNull(),
  /** Consecutive passing runs while open; it takes two to resolve. */
  passes: integer("passes").notNull().default(0),
  /** When the current (or last) incident started. */
  firstSeenAt: ts("first_seen_at").notNull(),
  /** The last alert for this check, in any incident. */
  lastAlertedAt: ts("last_alerted_at"),
  resolvedAt: ts("resolved_at"),
});

/**
 * Payments from any Solana wallet through a pay link's Solana Action (a Blink). Each POST gets a fresh
 * reference key, put in the transfer as a read-only account so the payment can be found on-chain. The
 * watchdog cron looks the reference up and records the payment once: `signature` is set exactly once.
 * Rows still unpaid after `expiresAt` are deleted.
 */
export const actionPayments = sqliteTable("action_payments", {
  /** Also the transaction's memo, so a ledger row matches its transaction. */
  id: text("id").primaryKey(),
  reference: text("reference").notNull().unique(),
  recipientId: text("recipient_id")
    .notNull()
    .references(() => users.id),
  chain: text("chain", { enum: CHAINS }).notNull(),
  /** The recipient's Dial wallet the transfer pays. */
  recipientAddress: text("recipient_address").notNull(),
  /** The wallet that asked for the transaction; once paid, the wallet the money actually came from. */
  payerAddress: text("payer_address").notNull(),
  amount: amount("amount").notNull(),
  note: text("note"),
  createdAt: ts("created_at").notNull().default(now),
  expiresAt: ts("expires_at").notNull(),
  signature: text("signature").unique(),
  explorerUrl: text("explorer_url"),
  /** What the recipient's token account actually gained, which is what the ledger shows. */
  received: amount("received"),
  paidAt: ts("paid_at"),
});

export type User = typeof users.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Intent = typeof intents.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Passkey = typeof passkeys.$inferSelect;
export type AgentKey = typeof agentKeys.$inferSelect;
export type ActionPayment = typeof actionPayments.$inferSelect;

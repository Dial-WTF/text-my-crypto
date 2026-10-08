CREATE TYPE "public"."chain" AS ENUM('solana', 'tempo', 'base', 'zcash');--> statement-breakpoint
CREATE TYPE "public"."intent_status" AS ENUM('pending', 'settling', 'settled', 'failed');--> statement-breakpoint
CREATE TABLE "intents" (
	"id" text PRIMARY KEY NOT NULL,
	"sender_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"chain" "chain" NOT NULL,
	"token" text NOT NULL,
	"recipient_address" text NOT NULL,
	"amount" bigint NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "intent_status" DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"explorer_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sms_log" (
	"id" text PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"phone" text NOT NULL,
	"body" text NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_log_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"handle" text NOT NULL,
	"default_chain" "chain" DEFAULT 'solana' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" text NOT NULL,
	"chain" "chain" NOT NULL,
	"address" text NOT NULL,
	"secret_enc" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_chain" ON "wallets" USING btree ("user_id","chain");
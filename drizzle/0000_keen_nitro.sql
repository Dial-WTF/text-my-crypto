CREATE TABLE `contacts` (
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`owner_id`, `name`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`phone` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intents` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'send' NOT NULL,
	`created_by` text NOT NULL,
	`note` text,
	`sender_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`chain` text NOT NULL,
	`token` text NOT NULL,
	`recipient_address` text NOT NULL,
	`amount` integer NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`code_hash` text,
	`code_attempts` integer DEFAULT 0 NOT NULL,
	`escrow_secret_enc` text,
	`escrow_expires_at` integer,
	`tx_hash` text,
	`explorer_url` text,
	`release_tx_hash` text,
	`release_explorer_url` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `signup_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE TABLE `sms_log` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`phone` text NOT NULL,
	`body` text NOT NULL,
	`dedupe_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sms_log_dedupe_key_unique` ON `sms_log` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`handle` text,
	`claimed_at` integer,
	`default_chain` text DEFAULT 'solana' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_phone_unique` ON `users` (`phone`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE TABLE `wallets` (
	`user_id` text NOT NULL,
	`chain` text NOT NULL,
	`address` text NOT NULL,
	`secret_enc` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_user_chain` ON `wallets` (`user_id`,`chain`);
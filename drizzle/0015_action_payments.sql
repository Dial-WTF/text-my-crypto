CREATE TABLE `action_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`recipient_id` text NOT NULL,
	`chain` text NOT NULL,
	`recipient_address` text NOT NULL,
	`payer_address` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`signature` text,
	`explorer_url` text,
	`received` integer,
	`paid_at` integer,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_payments_reference_unique` ON `action_payments` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `action_payments_signature_unique` ON `action_payments` (`signature`);
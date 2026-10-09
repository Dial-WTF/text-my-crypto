ALTER TABLE `intents` ADD `split_id` text;--> statement-breakpoint
CREATE INDEX `intents_split` ON `intents` (`split_id`);
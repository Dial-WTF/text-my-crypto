ALTER TABLE `watchdog_problems` ADD `passes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `watchdog_problems` ADD `resolved_at` integer;
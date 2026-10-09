CREATE TABLE `watchdog_problems` (
	`key` text PRIMARY KEY NOT NULL,
	`detail` text NOT NULL,
	`failures` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_alerted_at` integer
);

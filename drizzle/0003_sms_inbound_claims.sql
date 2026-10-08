ALTER TABLE `sms_log` ADD `claim_id` text;--> statement-breakpoint
ALTER TABLE `sms_log` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `sms_log` ADD `handled_at` integer;--> statement-breakpoint
UPDATE `sms_log` SET `handled_at` = `created_at` WHERE `direction` = 'in';
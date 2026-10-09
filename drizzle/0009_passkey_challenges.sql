CREATE TABLE `passkey_challenges` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL
);

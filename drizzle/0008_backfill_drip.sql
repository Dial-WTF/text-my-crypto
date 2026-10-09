-- Wallets opened before the drip was tracked already got their signup drip. Mark them so a short send doesn't drip again.
UPDATE `wallets` SET `dripped_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE `dripped_at` IS NULL;

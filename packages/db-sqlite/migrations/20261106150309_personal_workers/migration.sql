-- Personal workers: a device someone registers with /register-worker serves only their tickets.
-- Shared workers keep these columns null.
ALTER TABLE `workers` ADD `owner_channel_type` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `name` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `secret_hash` text;--> statement-breakpoint
CREATE INDEX `workers_owner_idx` ON `workers` (`owner_channel_type`,`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workers_secret_hash_uq` ON `workers` (`secret_hash`);
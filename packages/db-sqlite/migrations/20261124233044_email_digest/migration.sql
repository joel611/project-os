CREATE TABLE `email_mailboxes` (
	`owner_channel_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`cursor` text,
	`last_sync_at` text,
	`needs_reconnect` integer NOT NULL,
	CONSTRAINT `email_mailboxes_pk` PRIMARY KEY(`owner_channel_type`, `owner_id`)
);
--> statement-breakpoint
CREATE TABLE `emails` (
	`id` text PRIMARY KEY,
	`owner_channel_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`from_name` text,
	`from_address` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`received_at` text NOT NULL,
	`status` text NOT NULL,
	`project_id` text,
	`assigned_by` text,
	`suggested_project_id` text,
	`confidence` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emails_owner_message_uq` ON `emails` (`owner_channel_type`,`owner_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `emails_owner_status_idx` ON `emails` (`owner_channel_type`,`owner_id`,`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `emails_status_received_idx` ON `emails` (`status`,`received_at`);
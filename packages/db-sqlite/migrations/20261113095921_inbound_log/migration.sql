CREATE TABLE `inbound_log` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text,
	`external_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`sender_name` text,
	`content` text NOT NULL,
	`mentions_bot` integer NOT NULL,
	`attachment_count` integer NOT NULL,
	`url` text,
	`received_at` text NOT NULL,
	CONSTRAINT `fk_inbound_log_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_log_external_uq` ON `inbound_log` (`channel_type`,`external_id`);--> statement-breakpoint
CREATE INDEX `inbound_log_project_received_idx` ON `inbound_log` (`project_id`,`received_at`);
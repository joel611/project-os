CREATE TABLE `channel_messages` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text,
	`external_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`sender_name` text,
	`content` text NOT NULL,
	`sent_at` text NOT NULL,
	CONSTRAINT `fk_channel_messages_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_messages_external_uq` ON `channel_messages` (`channel_type`,`external_id`);--> statement-breakpoint
CREATE INDEX `channel_messages_project_sent_idx` ON `channel_messages` (`project_id`,`sent_at`);
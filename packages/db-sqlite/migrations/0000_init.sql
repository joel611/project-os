CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`ticket_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`source_metadata` text,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_entries_project_created_idx` ON `memory_entries` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`direction` text NOT NULL,
	`is_default_response` integer NOT NULL,
	`config` text,
	`status` text NOT NULL,
	`connected_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_type_external_id_uq` ON `project_sources` (`type`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_one_default_per_project` ON `project_sources` (`project_id`) WHERE "project_sources"."is_default_response" = 1;--> statement-breakpoint
CREATE INDEX `project_sources_project_idx` ON `project_sources` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`custom_instructions` text NOT NULL,
	`default_response_channel_id` text,
	`status` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ticket_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`actor_id` text,
	`body` text NOT NULL,
	`payload` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_idx` ON `ticket_events` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`intent` text,
	`input_summary` text NOT NULL,
	`priority` text,
	`worker_type` text,
	`worker_id` text,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	`assigned_at` text,
	`started_at` text,
	`last_activity_at` text NOT NULL,
	`completed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tickets_status_worker_idx` ON `tickets` (`status`,`worker_id`);--> statement-breakpoint
CREATE INDEX `tickets_project_idx` ON `tickets` (`project_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_type` text NOT NULL,
	`current_ticket_id` text,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL
);

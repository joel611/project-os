CREATE TABLE `orgs` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_users_org_id_orgs_id_fk` FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`custom_instructions` text NOT NULL,
	`default_response_channel_id` text,
	`status` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_projects_org_id_orgs_id_fk` FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`)
);
--> statement-breakpoint
CREATE TABLE `project_sources` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`alias` text NOT NULL,
	`description` text,
	`direction` text NOT NULL,
	`is_default_response` integer NOT NULL,
	`config` text,
	`status` text NOT NULL,
	`connected_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_project_sources_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`ticket_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`source_metadata` text,
	`created_by` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_memory_entries_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY,
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
	CONSTRAINT `fk_tickets_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE TABLE `ticket_events` (
	`id` text PRIMARY KEY,
	`ticket_id` text NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`actor_id` text,
	`body` text NOT NULL,
	`payload` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_ticket_events_ticket_id_tickets_id_fk` FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`)
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY,
	`worker_type` text NOT NULL,
	`owner_channel_type` text,
	`owner_id` text,
	`name` text,
	`secret_hash` text,
	`current_ticket_id` text,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ticket_threads` (
	`ticket_id` text PRIMARY KEY,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_ticket_threads_ticket_id_tickets_id_fk` FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`)
);
--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_auth_accounts_user_id_auth_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_auth_sessions_user_id_auth_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_verifications` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_type_external_id_uq` ON `project_sources` (`type`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_project_alias_uq` ON `project_sources` (`project_id`,`alias`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_one_default_per_project` ON `project_sources` (`project_id`) WHERE "project_sources"."is_default_response" = 1;--> statement-breakpoint
CREATE INDEX `project_sources_project_idx` ON `project_sources` (`project_id`);--> statement-breakpoint
CREATE INDEX `memory_entries_project_created_idx` ON `memory_entries` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tickets_status_worker_idx` ON `tickets` (`status`,`worker_id`);--> statement-breakpoint
CREATE INDEX `tickets_project_idx` ON `tickets` (`project_id`);--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_idx` ON `ticket_events` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workers_owner_idx` ON `workers` (`owner_channel_type`,`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workers_secret_hash_uq` ON `workers` (`secret_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_threads_thread_uq` ON `ticket_threads` (`channel_type`,`thread_id`);--> statement-breakpoint
CREATE INDEX `auth_accounts_user_idx` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_verifications_identifier_idx` ON `auth_verifications` (`identifier`);
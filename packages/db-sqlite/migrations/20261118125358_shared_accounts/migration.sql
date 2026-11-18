CREATE TABLE `shared_account_assignments` (
	`channel_type` text NOT NULL,
	`person_id` text NOT NULL,
	`provider` text NOT NULL,
	`shared_account_id` text NOT NULL,
	`assigned_by` text NOT NULL,
	`assigned_at` text NOT NULL,
	CONSTRAINT `shared_account_assignments_pk` PRIMARY KEY(`channel_type`, `person_id`, `provider`),
	CONSTRAINT `fk_shared_account_assignments_shared_account_id_shared_accounts_id_fk` FOREIGN KEY (`shared_account_id`) REFERENCES `shared_accounts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `shared_accounts` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`user_id` text NOT NULL UNIQUE,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_shared_accounts_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `shared_assignments_account_idx` ON `shared_account_assignments` (`shared_account_id`);--> statement-breakpoint
CREATE INDEX `shared_accounts_provider_idx` ON `shared_accounts` (`provider`);
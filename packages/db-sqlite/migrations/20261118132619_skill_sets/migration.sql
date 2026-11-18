CREATE TABLE `skill_sets` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY,
	`skill_set_id` text NOT NULL,
	`source` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`path` text NOT NULL,
	`sha` text NOT NULL,
	`files` text NOT NULL,
	`file_count` integer NOT NULL,
	`bytes` integer NOT NULL,
	`fetched_at` text NOT NULL,
	`fetched_by` text,
	CONSTRAINT `fk_skills_skill_set_id_skill_sets_id_fk` FOREIGN KEY (`skill_set_id`) REFERENCES `skill_sets`(`id`)
);
--> statement-breakpoint
ALTER TABLE `tickets` ADD `skill_set_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `skill_sets_name_uq` ON `skill_sets` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `skills_set_source_slug_uq` ON `skills` (`skill_set_id`,`source`,`slug`);--> statement-breakpoint
CREATE INDEX `skills_set_idx` ON `skills` (`skill_set_id`);
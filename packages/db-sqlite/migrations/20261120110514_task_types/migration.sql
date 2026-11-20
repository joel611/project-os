ALTER TABLE `skill_sets` RENAME TO `task_types`;--> statement-breakpoint
ALTER TABLE `tickets` RENAME COLUMN `skill_set_id` TO `task_type_id`;--> statement-breakpoint
ALTER TABLE `skills` RENAME COLUMN `skill_set_id` TO `task_type_id`;--> statement-breakpoint
ALTER TABLE `task_types` ADD `instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `skills_set_source_slug_uq`;--> statement-breakpoint
DROP INDEX IF EXISTS `skills_set_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `skill_sets_name_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `skills_task_type_source_slug_uq` ON `skills` (`task_type_id`,`source`,`slug`);--> statement-breakpoint
CREATE INDEX `skills_task_type_idx` ON `skills` (`task_type_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_types_name_uq` ON `task_types` (`name`);
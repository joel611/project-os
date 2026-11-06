-- Every source gets an alias, unique within its project. The DEFAULT '' only lets SQLite add a
-- NOT NULL column to existing rows; the backfill below replaces it and new rows always set one.
ALTER TABLE `project_sources` ADD `alias` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `project_sources` ADD `description` text;--> statement-breakpoint
-- Backfill: a channel's own name (`#design` -> `design`), a repo's name (`acme/web` -> `web`),
-- otherwise the kind of source (`discord`, `drive`, `email`, `clickup`).
UPDATE `project_sources` SET `alias` = CASE
  WHEN `type` = 'discord_channel' AND `name` GLOB '#?*' THEN lower(replace(substr(`name`, 2), ' ', '-'))
  WHEN `type` = 'discord_channel' THEN 'discord'
  WHEN `type` = 'github_repo' THEN lower(replace(substr(`external_id`, instr(`external_id`, '/') + 1), '.', '-'))
  WHEN `type` = 'google_drive_folder' THEN 'drive'
  WHEN `type` = 'email_address' THEN 'email'
  WHEN `type` = 'clickup_list' THEN 'clickup'
  ELSE 'source'
END;--> statement-breakpoint
-- Same alias twice in a project: the older source keeps it, later ones get their id's prefix.
UPDATE `project_sources` SET `alias` = `alias` || '-' || substr(`id`, 1, 8)
WHERE EXISTS (
  SELECT 1 FROM `project_sources` AS `older`
  WHERE `older`.`project_id` = `project_sources`.`project_id`
    AND `older`.`alias` = `project_sources`.`alias`
    AND (`older`.`created_at` < `project_sources`.`created_at`
      OR (`older`.`created_at` = `project_sources`.`created_at` AND `older`.`id` < `project_sources`.`id`))
);--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_project_alias_uq` ON `project_sources` (`project_id`,`alias`);

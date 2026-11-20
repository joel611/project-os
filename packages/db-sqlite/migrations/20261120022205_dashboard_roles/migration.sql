ALTER TABLE `session` ADD `impersonated_by` text;--> statement-breakpoint
ALTER TABLE `user` ADD `role` text;--> statement-breakpoint
ALTER TABLE `user` ADD `banned` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `user` ADD `ban_reason` text;--> statement-breakpoint
ALTER TABLE `user` ADD `ban_expires` integer;--> statement-breakpoint
-- Everyone who could use the dashboard before roles existed stays an admin. Channel identities and
-- shared-account placeholders (never dashboard operators) are members.
UPDATE `user` SET `role` = CASE
  WHEN `email` LIKE '%@people.project-os.invalid' OR `email` LIKE '%@shared.project-os.invalid' THEN 'member'
  ELSE 'admin'
END;

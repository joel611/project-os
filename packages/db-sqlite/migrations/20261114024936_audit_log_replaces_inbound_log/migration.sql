CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`action` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_name` text,
	`project_id` text,
	`ticket_id` text,
	`worker_id` text,
	`summary` text NOT NULL,
	`payload` text,
	`dedupe_key` text,
	CONSTRAINT `fk_audit_log_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_dedupe_uq` ON `audit_log` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_project_idx` ON `audit_log` (`project_id`);--> statement-breakpoint
CREATE INDEX `audit_log_kind_idx` ON `audit_log` (`kind`);
--> statement-breakpoint
-- Every message the inbound log kept becomes an inbound_event entry, with the same id.
INSERT INTO `audit_log` (`id`, `at`, `kind`, `action`, `actor_type`, `actor_id`, `actor_name`, `project_id`, `summary`, `payload`, `dedupe_key`)
SELECT
	`id`,
	`received_at`,
	'inbound_event',
	'received',
	'person',
	`sender_id`,
	`sender_name`,
	`project_id`,
	CASE
		WHEN `content` = '' AND `attachment_count` > 0 THEN `attachment_count` || ' attachment(s)'
		WHEN length(`content`) > 140 THEN substr(`content`, 1, 139) || '…'
		ELSE `content`
	END,
	json_object(
		'channelType', `channel_type`,
		'channelId', `channel_id`,
		'threadId', `thread_id`,
		'externalId', `external_id`,
		'content', `content`,
		'mentionsBot', json(CASE WHEN `mentions_bot` THEN 'true' ELSE 'false' END),
		'attachmentCount', `attachment_count`,
		'url', `url`
	),
	'inbound:' || `channel_type` || ':' || `external_id`
FROM `inbound_log`
ORDER BY `received_at`, `rowid`;
--> statement-breakpoint
DROP INDEX IF EXISTS `inbound_log_external_uq`;--> statement-breakpoint
DROP INDEX IF EXISTS `inbound_log_project_received_idx`;--> statement-breakpoint
DROP TABLE `inbound_log`;

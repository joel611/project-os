ALTER TABLE `tickets` ADD `requester` text;
--> statement-breakpoint
-- Queued tickets (open, no worker) made before `requester` existed: take it from the `created` event.
UPDATE `tickets` SET `requester` = (
	SELECT json_object(
		'channelType', json_extract(`e`.`payload`, '$.channelType'),
		'id', json_extract(`e`.`payload`, '$.sender.id')
	)
	FROM `ticket_events` `e`
	WHERE `e`.`ticket_id` = `tickets`.`id`
		AND `e`.`type` = 'created'
		AND json_valid(`e`.`payload`)
		AND json_extract(`e`.`payload`, '$.channelType') IS NOT NULL
		AND json_extract(`e`.`payload`, '$.sender.id') IS NOT NULL
	ORDER BY `e`.`created_at`
	LIMIT 1
) WHERE `status` = 'open' AND `worker_id` IS NULL;

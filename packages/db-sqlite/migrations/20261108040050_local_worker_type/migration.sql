UPDATE `workers` SET `worker_type` = 'local' WHERE `worker_type` IN ('local_claude', 'local_pi');
--> statement-breakpoint
UPDATE `tickets` SET `worker_type` = 'local' WHERE `worker_type` IN ('local_claude', 'local_pi');
--> statement-breakpoint
UPDATE `ticket_events` SET `payload` = replace(replace(`payload`, '"local_claude"', '"local"'), '"local_pi"', '"local"') WHERE `payload` LIKE '%"local\_%' ESCAPE '\';

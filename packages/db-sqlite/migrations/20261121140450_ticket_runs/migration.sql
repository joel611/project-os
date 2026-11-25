CREATE TABLE `ticket_runs` (
	`id` text PRIMARY KEY,
	`ticket_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`agent` text NOT NULL,
	`model` text,
	`status` text NOT NULL,
	`exit_code` integer,
	`started_at` text NOT NULL,
	`ended_at` text,
	`event_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`next_seq` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`expired` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_ticket_runs_ticket_id_tickets_id_fk` FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`)
);
--> statement-breakpoint
CREATE INDEX `ticket_runs_ticket_idx` ON `ticket_runs` (`ticket_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `ticket_runs_started_idx` ON `ticket_runs` (`started_at`);
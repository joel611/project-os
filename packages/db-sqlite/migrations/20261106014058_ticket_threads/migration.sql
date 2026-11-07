CREATE TABLE `ticket_threads` (
	`ticket_id` text PRIMARY KEY NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_threads_thread_uq` ON `ticket_threads` (`channel_type`,`thread_id`);
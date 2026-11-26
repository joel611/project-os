ALTER TABLE `ticket_runs` ADD `assigned_at` text;
--> statement-breakpoint
-- requestStop guards the run and assignment in its UPDATE. This trigger makes the
-- ticket hold and the persistent, run-specific signal visible together on SQLite and D1.
CREATE TRIGGER `ticket_run_force_stop`
AFTER UPDATE OF `status` ON `ticket_runs`
WHEN OLD.status = 'running' AND NEW.status = 'stopped'
BEGIN
  UPDATE `tickets`
  SET status = 'stopped', completed_at = NEW.ended_at,
      last_activity_at = NEW.ended_at, updated_at = NEW.ended_at
  WHERE id = NEW.ticket_id;
END;

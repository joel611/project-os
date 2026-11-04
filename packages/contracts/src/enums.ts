import { Schema } from "effect";

export const ChannelType = Schema.Literals(["discord", "email", "chat"]);
export type ChannelType = typeof ChannelType.Type;

export const PROJECT_SOURCE_TYPES = [
  "discord_channel",
  "email_address",
  "clickup_list",
  "google_drive_folder",
  "github_repo",
] as const;
export const ProjectSourceType = Schema.Literals(PROJECT_SOURCE_TYPES);
export type ProjectSourceType = typeof ProjectSourceType.Type;

export const TicketEventType = Schema.Literals([
  "created",
  "assigned",
  "status_update",
  "comment",
  "follow_up",
  "result",
  "error",
  "system",
]);
export type TicketEventType = typeof TicketEventType.Type;

export const Actor = Schema.Literals(["coordinator", "worker", "system"]);
export type Actor = typeof Actor.Type;

export const WorkerType = Schema.Literals(["daytona_pi", "local_claude", "local_pi"]);
export type WorkerType = typeof WorkerType.Type;

export const MemoryEntryType = Schema.Literals([
  "email_summary",
  "manual",
  "status_update",
  "worker_result",
  "worker_note",
  "note",
]);
export type MemoryEntryType = typeof MemoryEntryType.Type;

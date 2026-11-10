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

/** Agent CLIs a Watcher can run a session on (`/register-worker agent:`, `register --agent`). */
export const WATCHER_AGENTS = ["claude", "pi", "codex"] as const;
export type WatcherAgent = (typeof WATCHER_AGENTS)[number];

/**
 * Pi in a cloud sandbox, one per provider: `daytona_pi` (Daytona), `cloudflare_pi` (Cloudflare
 * Sandbox), `boat_pi` (boat.dev). The Coordinator starts these itself, picking from the pool.
 */
export const SANDBOX_WORKER_TYPES = ["daytona_pi", "cloudflare_pi", "boat_pi"] as const;
export type SandboxWorkerType = (typeof SANDBOX_WORKER_TYPES)[number];

/**
 * `local`: a registered computer running the Watcher, whatever agent CLI it uses (the Watcher
 * picks that at each start). `sidekick`: the Coordinator's in-process tool-only helper, not a
 * pull-model Worker.
 */
export const WORKER_TYPES = [...SANDBOX_WORKER_TYPES, "local", "sidekick"] as const;
export const WorkerType = Schema.Literals(WORKER_TYPES);
export type WorkerType = typeof WorkerType.Type;

/** Sandbox providers by name, as written in `WORKER_PROVIDERS`. */
export const SANDBOX_PROVIDERS = ["daytona", "cloudflare", "boat"] as const;
export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

/** The provider each sandbox worker type runs on. Its session ids are `<provider>-<ticketId>`. */
export const SANDBOX_PROVIDER_OF: Readonly<Record<SandboxWorkerType, SandboxProvider>> = {
  daytona_pi: "daytona",
  cloudflare_pi: "cloudflare",
  boat_pi: "boat",
};

export const MemoryEntryType = Schema.Literals([
  "email_summary",
  "manual",
  "status_update",
  "worker_result",
  "worker_note",
  "note",
]);
export type MemoryEntryType = typeof MemoryEntryType.Type;

/** Third-party accounts a person can link so Workers act with that person's own access. */
export const CONNECTION_PROVIDERS = ["google", "github", "clickup"] as const;
export const ConnectionProvider = Schema.Literals(CONNECTION_PROVIDERS);
export type ConnectionProvider = typeof ConnectionProvider.Type;

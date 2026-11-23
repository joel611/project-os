import {
  type DetectedSource,
  detectSource,
  type ProjectSourceType,
  type Run,
  type RunEvent,
  type RunEventType,
  type RunStatus,
  TERMINAL_STATUSES,
  type Ticket,
  type TicketEvent,
  type TicketEventType,
  type TicketStatus,
  type Worker,
  type WorkerStatus,
  type WorkerType,
} from "@project-os/contracts";

export type Tone = "neutral" | "info" | "progress" | "warn" | "success" | "danger";

export interface StatusMeta {
  readonly label: string;
  readonly tone: Tone;
  readonly terminal: boolean;
}

const status = (label: string, tone: Tone, s: TicketStatus): StatusMeta => ({
  label,
  tone,
  terminal: TERMINAL_STATUSES.includes(s),
});

export const STATUS: Readonly<Record<TicketStatus, StatusMeta>> = {
  open: status("Open", "neutral", "open"),
  assigned: status("Assigned", "info", "assigned"),
  in_progress: status("In progress", "progress", "in_progress"),
  blocked: status("Blocked", "warn", "blocked"),
  completed: status("Completed", "success", "completed"),
  failed: status("Failed", "danger", "failed"),
  cancelled: status("Cancelled", "neutral", "cancelled"),
};

export const EVENT: Readonly<
  Record<TicketEventType, { readonly label: string; readonly tone: Tone }>
> = {
  created: { label: "Created", tone: "neutral" },
  assigned: { label: "Assigned", tone: "info" },
  status_update: { label: "Status", tone: "progress" },
  comment: { label: "Comment", tone: "neutral" },
  follow_up: { label: "Follow-up", tone: "warn" },
  result: { label: "Result", tone: "success" },
  error: { label: "Error", tone: "danger" },
  system: { label: "System", tone: "neutral" },
};

const byRecentActivity = (a: Ticket, b: Ticket) => b.lastActivityAt.localeCompare(a.lastActivityAt);

/** Live work first, then finished work; each most recently active first. */
export const splitTickets = (tickets: ReadonlyArray<Ticket>) => ({
  active: tickets.filter((t) => !STATUS[t.status].terminal).sort(byRecentActivity),
  done: tickets.filter((t) => STATUS[t.status].terminal).sort(byRecentActivity),
});

/** Ticket activity timeline, newest first. Stable for events sharing a timestamp (later in the feed wins). */
export const newestFirst = <E extends { readonly createdAt: string }>(
  events: ReadonlyArray<E>,
): E[] =>
  events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.createdAt.localeCompare(a.e.createdAt) || b.i - a.i)
    .map(({ e }) => e);

const UNITS = [
  { ms: 86_400_000, suffix: "d" },
  { ms: 3_600_000, suffix: "h" },
  { ms: 60_000, suffix: "m" },
] as const;

export const relativeTime = (iso: string, now: Date): string => {
  const elapsed = now.getTime() - Date.parse(iso);
  const unit = UNITS.find((u) => elapsed >= u.ms);
  return unit ? `${Math.floor(elapsed / unit.ms)}${unit.suffix} ago` : "just now";
};

/** What the dashboard POSTs: the detected source plus its alias and optional description. */
export interface SourceInput extends DetectedSource {
  readonly alias: string;
  readonly description?: string;
}

/** Same rule as the Coordinator: lowercase letters and digits joined by `-` or `_`, ≤ 40 chars. */
export const ALIAS_HINT = "Lowercase letters and digits joined by - or _, at most 40 characters.";
const ALIAS_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const normalizeAlias = (raw: string): string | null => {
  const alias = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return alias.length <= 40 && ALIAS_PATTERN.test(alias) ? alias : null;
};

export type SourceCheck =
  | { readonly kind: "ok"; readonly input: SourceInput }
  | { readonly kind: "invalid" }
  | { readonly kind: "duplicate"; readonly input: DetectedSource }
  | { readonly kind: "bad_alias" }
  | { readonly kind: "alias_taken"; readonly alias: string };

/** Flags junk, sources already on the project, and aliases that are malformed or taken. */
export const checkSource = (
  raw: { readonly link: string; readonly alias: string; readonly description?: string },
  existing: ReadonlyArray<{
    readonly type: string;
    readonly externalId: string;
    readonly alias: string;
  }>,
): SourceCheck => {
  const detected = detectSource(raw.link);
  if (!detected) return { kind: "invalid" };
  if (existing.some((s) => s.type === detected.type && s.externalId === detected.externalId))
    return { kind: "duplicate", input: detected };
  const alias = normalizeAlias(raw.alias);
  if (!alias) return { kind: "bad_alias" };
  if (existing.some((s) => s.alias === alias)) return { kind: "alias_taken", alias };
  const description = raw.description?.trim();
  return { kind: "ok", input: { ...detected, alias, ...(description ? { description } : {}) } };
};

/** Where a linked source lives on the web, when it has a link-out. */
export const sourceUrl = (s: { type: string; externalId: string }): string | null =>
  s.type === "github_repo"
    ? `https://github.com/${s.externalId}`
    : s.type === "google_drive_folder"
      ? `https://drive.google.com/drive/folders/${s.externalId}`
      : null;

/**
 * Where a worker sits: a `shared` device an admin registered into the pool, someone's
 * `personal` device, or a `sandbox` session the Coordinator started for one ticket.
 */
/** Who hosts a source; the settings page groups sources under one header per provider. */
export type SourceProvider = "github" | "google_drive" | "discord" | "clickup" | "email" | "other";

const SOURCE_PROVIDER: Readonly<Record<ProjectSourceType, SourceProvider>> = {
  github_repo: "github",
  google_drive_folder: "google_drive",
  discord_channel: "discord",
  clickup_list: "clickup",
  email_address: "email",
};

/** Group order on the page; "other" catches a type this build doesn't know yet. */
const PROVIDER_ORDER: ReadonlyArray<SourceProvider> = [
  "github",
  "google_drive",
  "discord",
  "clickup",
  "email",
  "other",
];

export const sourceProvider = (type: string): SourceProvider =>
  Object.hasOwn(SOURCE_PROVIDER, type) ? SOURCE_PROVIDER[type as ProjectSourceType] : "other";

/** Sources bucketed by provider in page order, keeping each bucket's order; empty buckets are dropped. */
export const groupSources = <S extends { readonly type: string }>(
  sources: ReadonlyArray<S>,
): ReadonlyArray<{ readonly provider: SourceProvider; readonly sources: ReadonlyArray<S> }> =>
  PROVIDER_ORDER.map((provider) => ({
    provider,
    sources: sources.filter((s) => sourceProvider(s.type) === provider),
  })).filter((g) => g.sources.length > 0);

/** Source types whose messages reach the project (see core `CHANNEL_SOURCE_TYPES`). */
const INBOUND_SOURCE_TYPES: ReadonlySet<string> = new Set(["discord_channel", "email_address"]);

/** What to type before a source is removed: "remove github", "remove drive", else its alias. */
export const confirmPhrase = (s: { readonly type: string; readonly alias: string }): string =>
  s.type === "github_repo"
    ? "remove github"
    : s.type === "google_drive_folder"
      ? "remove drive"
      : `remove ${s.alias}`;

/** What removing a source changes, for the confirmation before it goes. */
export const removalNote = (s: {
  readonly type: string;
  readonly isDefaultResponse: boolean;
}): string =>
  (INBOUND_SOURCE_TYPES.has(s.type)
    ? "Workers will no longer see it, and its messages will stop reaching this project."
    : "Workers will no longer see it.") +
  (s.isDefaultResponse
    ? " It is the reply channel, so the project will have none until you link another."
    : "");

export type WorkerGroup = "shared" | "personal" | "sandbox";

export const workerGroup = (w: Worker): WorkerGroup =>
  !w.registered ? "sandbox" : w.ownerId === null ? "shared" : "personal";

/** What a worker is, on its detail page. */
export const WORKER_GROUP_LABEL: Readonly<Record<WorkerGroup, string>> = {
  shared: "Shared device",
  personal: "Personal device",
  sandbox: "Sandbox session",
};

/** What runs the worker's sessions. */
export const WORKER_TYPE_LABEL: Readonly<Record<WorkerType, string>> = {
  local: "Watcher",
  daytona_pi: "Pi on Daytona",
  cloudflare_pi: "Pi on Cloudflare Sandbox",
  boat_pi: "Pi on boat.dev",
  sidekick: "Sidekick",
};

/** A worker's last heartbeat, relative; "never" before its first (`lastSeenAt` at epoch). */
export const lastSeen = (w: Pick<Worker, "lastSeenAt">, now: Date): string =>
  Date.parse(w.lastSeenAt) <= 0 ? "never" : relativeTime(w.lastSeenAt, now);

/** How the dashboard names a worker: its registered name, else its id. */
export const workerName = (w: Worker): string => w.name ?? w.id;

/**
 * Workers for the sidebar, by group, online first then by name. Registered devices show
 * whether they are online or not; a sandbox session only while it is online.
 */
export const groupWorkers = <W extends Worker & { readonly status: WorkerStatus }>(
  workers: ReadonlyArray<W>,
): Readonly<Record<WorkerGroup, ReadonlyArray<W>>> => {
  const sorted = [...workers].sort(
    (a, b) =>
      Number(b.status === "online") - Number(a.status === "online") ||
      workerName(a).localeCompare(workerName(b)),
  );
  const of = (group: WorkerGroup) => sorted.filter((w) => workerGroup(w) === group);
  return {
    shared: of("shared"),
    personal: of("personal"),
    sandbox: of("sandbox").filter((w) => w.status === "online"),
  };
};

/** Ticket statuses an Operator can (re)assign from: any not finished. */
export const ASSIGNABLE_STATUSES: ReadonlyArray<TicketStatus> = [
  "open",
  "assigned",
  "in_progress",
  "blocked",
];

/**
 * Who an Operator can hand a ticket to: registered devices (shared, then personal, online
 * first) other than its current worker. Sandbox sessions are started by the Coordinator only.
 */
export const assignTargets = <W extends Worker & { readonly status: WorkerStatus }>(
  workers: ReadonlyArray<W>,
  currentWorkerId: string | null,
): ReadonlyArray<W> => {
  const { shared, personal } = groupWorkers(workers);
  return [...shared, ...personal].filter((w) => w.id !== currentWorkerId);
};

/**
 * Whether anyone sent files on this ticket (its `created` or `follow_up` events carry a list),
 * so the dashboard only asks for download links when there is something to show.
 */
export const hasAttachments = (events: ReadonlyArray<Pick<TicketEvent, "payload">>): boolean =>
  events.some((e) => {
    const attachments = (e.payload as { attachments?: unknown } | null)?.attachments;
    return Array.isArray(attachments) && attachments.length > 0;
  });

/** Types the browser draws as a picture. SVG is left out: it is a document, not a bitmap. */
export const isShownInline = (contentType: string | null): boolean =>
  contentType !== null && /^image\/(png|jpeg|gif|webp|avif)$/.test(contentType);

/** `1536` as `1.5 KB`. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
};

export const RUN_STATUS: Readonly<
  Record<RunStatus, { readonly label: string; readonly tone: Tone }>
> = {
  running: { label: "Running", tone: "progress" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export const RUN_EVENT: Readonly<
  Record<RunEventType, { readonly label: string; readonly tone: Tone }>
> = {
  lifecycle: { label: "Session", tone: "info" },
  message: { label: "Agent", tone: "neutral" },
  tool_call: { label: "Tool call", tone: "progress" },
  tool_result: { label: "Tool result", tone: "neutral" },
  output: { label: "Output", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

/** How long a run took, like `2m 5s`; the time since it started while it is still running. */
export const runDuration = (run: Pick<Run, "startedAt" | "endedAt">, now: Date): string => {
  const end = run.endedAt ? Date.parse(run.endedAt) : now.getTime();
  const seconds = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** The events that match the search and the type filter; a blank search matches everything. */
export const filterRunEvents = (
  events: ReadonlyArray<RunEvent>,
  options: { readonly search: string; readonly hidden: ReadonlySet<RunEventType> },
): ReadonlyArray<RunEvent> => {
  const needle = options.search.trim().toLowerCase();
  return events.filter(
    (e) =>
      !options.hidden.has(e.type) &&
      (needle === "" || `${e.tool ?? ""} ${e.text}`.toLowerCase().includes(needle)),
  );
};

/** The transcript as it is stored, one JSON event per line, for downloading. */
export const runToJsonl = (events: ReadonlyArray<RunEvent>): string =>
  events.map((e) => JSON.stringify(e)).join("\n") + "\n";

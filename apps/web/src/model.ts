import {
  type DetectedSource,
  detectSource,
  TERMINAL_STATUSES,
  type Ticket,
  type TicketEvent,
  type TicketEventType,
  type TicketStatus,
  type Worker,
  type WorkerStatus,
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
export type WorkerGroup = "shared" | "personal" | "sandbox";

export const workerGroup = (w: Worker): WorkerGroup =>
  !w.registered ? "sandbox" : w.ownerId === null ? "shared" : "personal";

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

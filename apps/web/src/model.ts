import {
  TERMINAL_STATUSES,
  type Ticket,
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

/** What a pasted link turns into, before the operator names it. */
export interface DetectedSource {
  readonly type: "github_repo" | "google_drive_folder";
  readonly externalId: string;
  readonly name: string;
}

/** What the dashboard POSTs: the detected source plus its alias and optional description. */
export interface SourceInput extends DetectedSource {
  readonly alias: string;
  readonly description?: string;
}

const GITHUB_REPO =
  /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/;
const DRIVE_FOLDER =
  /^(?:(?:https?:\/\/)?drive\.google\.com\/.*?\/folders\/)?([\w-]{10,})(?:[/?#].*)?$/;

/**
 * Turns what an operator pastes (URL or short form) into the `(type, externalId)` the Coordinator
 * keys on. GitHub names are case-insensitive, so they are lowercased to keep the key canonical.
 */
const parseRepo = (text: string): DetectedSource | null => {
  const m = GITHUB_REPO.exec(text);
  if (!m) return null;
  const externalId = `${m[1]}/${m[2]}`.toLowerCase();
  return { type: "github_repo", externalId, name: externalId };
};

const parseFolder = (text: string): DetectedSource | null => {
  const id = DRIVE_FOLDER.exec(text)?.[1];
  return id
    ? { type: "google_drive_folder", externalId: id, name: `Drive folder ${id.slice(0, 8)}…` }
    : null;
};

/**
 * Detects the source type from what an operator pastes and normalizes it to the
 * `(type, externalId)` the Coordinator keys on. Repo names are case-insensitive, so they are
 * lowercased to keep the key canonical. `owner/repo` is a repo, a bare long id is a Drive folder.
 */
export const detectSource = (raw: string): DetectedSource | null => {
  const text = raw.trim();
  if (text.includes("drive.google.com")) return parseFolder(text);
  return parseRepo(text) ?? parseFolder(text);
};

/** Same rule as the Coordinator: lowercase letters and digits joined by `-` or `_`, ≤ 40 chars. */
export const ALIAS_HINT = "Lowercase letters and digits joined by - or _, at most 40 characters.";
const ALIAS_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const normalizeAlias = (raw: string): string | null => {
  const alias = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return alias.length <= 40 && ALIAS_PATTERN.test(alias) ? alias : null;
};

/** A starting alias for a pasted link: a repo's name. A Drive folder id says nothing, so none. */
export const suggestAlias = (source: DetectedSource | null): string =>
  source?.type === "github_repo"
    ? source.externalId
        .slice(source.externalId.indexOf("/") + 1)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
    : "";

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

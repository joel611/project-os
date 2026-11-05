import {
  TERMINAL_STATUSES,
  type Ticket,
  type TicketEventType,
  type TicketStatus,
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

export interface SourceInput {
  readonly type: "github_repo" | "google_drive_folder";
  readonly externalId: string;
  readonly name: string;
}

const GITHUB_REPO =
  /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/;
const DRIVE_FOLDER =
  /^(?:(?:https?:\/\/)?drive\.google\.com\/.*?\/folders\/)?([\w-]{10,})(?:[/?#].*)?$/;

/**
 * Turns what an operator pastes (URL or short form) into the `(type, externalId)` the Coordinator
 * keys on. GitHub names are case-insensitive, so they are lowercased to keep the key canonical.
 */
const parseRepo = (text: string): SourceInput | null => {
  const m = GITHUB_REPO.exec(text);
  if (!m) return null;
  const externalId = `${m[1]}/${m[2]}`.toLowerCase();
  return { type: "github_repo", externalId, name: externalId };
};

const parseFolder = (text: string): SourceInput | null => {
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
export const detectSource = (raw: string): SourceInput | null => {
  const text = raw.trim();
  if (text.includes("drive.google.com")) return parseFolder(text);
  return parseRepo(text) ?? parseFolder(text);
};

export type SourceCheck =
  | { readonly kind: "ok"; readonly input: SourceInput }
  | { readonly kind: "invalid" }
  | { readonly kind: "duplicate"; readonly input: SourceInput };

/** Flags junk and sources already on the project. */
export const checkSource = (
  raw: string,
  existing: ReadonlyArray<{ readonly type: string; readonly externalId: string }>,
): SourceCheck => {
  const input = detectSource(raw);
  if (!input) return { kind: "invalid" };
  return existing.some((s) => s.type === input.type && s.externalId === input.externalId)
    ? { kind: "duplicate", input }
    : { kind: "ok", input };
};

/** Where a linked source lives on the web, when it has a link-out. */
export const sourceUrl = (s: { type: string; externalId: string }): string | null =>
  s.type === "github_repo"
    ? `https://github.com/${s.externalId}`
    : s.type === "google_drive_folder"
      ? `https://drive.google.com/drive/folders/${s.externalId}`
      : null;

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

export const ADDABLE_SOURCES = ["github_repo", "google_drive_folder"] as const;
export type AddableSource = (typeof ADDABLE_SOURCES)[number];

export interface SourceInput {
  readonly type: AddableSource;
  readonly externalId: string;
  readonly name: string;
}

const GITHUB_REPO =
  /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/;
const DRIVE_FOLDER = /^(?:https?:\/\/drive\.google\.com\/.*?\/folders\/)?([\w-]{10,})(?:[/?#].*)?$/;

/** Turns what an operator pastes (URL or short form) into the `(type, externalId)` the Coordinator keys on. */
export const parseSource = (type: AddableSource, raw: string): SourceInput | null => {
  const text = raw.trim();
  if (type === "github_repo") {
    const m = GITHUB_REPO.exec(text);
    if (!m) return null;
    const externalId = `${m[1]}/${m[2]}`;
    return { type, externalId, name: externalId };
  }
  const id = DRIVE_FOLDER.exec(text)?.[1];
  return id ? { type, externalId: id, name: `Drive folder ${id.slice(0, 8)}…` } : null;
};

// Placeholder so the package has a real export; the full set of schemas lands in #7.
export const TICKET_STATUSES = [
  "open",
  "assigned",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

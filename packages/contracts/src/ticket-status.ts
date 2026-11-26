import { Schema } from "effect";

export const TICKET_STATUSES = [
  "open",
  "assigned",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "stopped",
] as const;

export const TicketStatus = Schema.Literals(TICKET_STATUSES);
export type TicketStatus = typeof TicketStatus.Type;

export const TERMINAL_STATUSES: ReadonlyArray<TicketStatus> = [
  "completed",
  "failed",
  "cancelled",
  "stopped",
];

import { TERMINAL_STATUSES, type TicketStatus } from "@project-os/contracts";

/** Poll cadence for data that moves while work is running (ticket lists and details). */
export const LIVE_MS = 3_000;
/** Poll cadence for data that rarely changes (projects, workers, memory, project settings). */
export const SLOW_MS = 15_000;

const isActive = (status: TicketStatus) => !TERMINAL_STATUSES.includes(status);

/** Tickets poll fast only while one can still change; a list of finished tickets idles. */
export const ticketListInterval = (tickets: ReadonlyArray<{ status: TicketStatus }> | undefined) =>
  tickets === undefined || tickets.some((t) => isActive(t.status)) ? LIVE_MS : SLOW_MS;

/** A finished ticket stops changing, so its detail stops polling. */
export const ticketDetailInterval = (ticket: { status: TicketStatus } | undefined) =>
  ticket?.status === "stopped"
    ? SLOW_MS
    : ticket === undefined || isActive(ticket.status)
      ? LIVE_MS
      : false;

const ACTIVITY_BASE_MS = 2_000;
const ACTIVITY_MAX_MS = 10_000;

/** The map's next poll delay: the base while things move, doubling per quiet read up to a cap. */
export const activityInterval = (quietReads: number) =>
  Math.min(ACTIVITY_MAX_MS, ACTIVITY_BASE_MS * 2 ** quietReads);

import {
  IdGenerator,
  MemoryRepository,
  TicketRepository,
  type MemoryEntryType,
  type Ticket,
  type TicketEvent,
  type WorkerType,
} from "@project-os/core";
import { Effect } from "effect";

interface QaTicket {
  readonly title: string;
  readonly status: Ticket["status"];
  readonly summary: string;
  readonly priority: string | null;
  readonly worker: { readonly type: WorkerType; readonly id: string } | null;
  readonly ageMinutes: number;
  readonly result?: unknown;
  readonly error?: string;
  readonly events: ReadonlyArray<Pick<TicketEvent, "type" | "actor" | "body">>;
}

const QA_TICKETS: ReadonlyArray<QaTicket> = [
  {
    title: "Draft launch announcement for v2",
    status: "open",
    summary: "Draft a launch announcement for v2 and post it in #general.",
    priority: null,
    worker: null,
    ageMinutes: 5,
    events: [
      { type: "created", actor: "coordinator", body: "Draft a launch announcement for v2." },
    ],
  },
  {
    title: "Summarize last week's support emails",
    status: "assigned",
    summary: "Summarize last week's support emails into themes.",
    priority: "high",
    worker: { type: "local_claude", id: "qa-worker-claude" },
    ageMinutes: 30,
    events: [
      { type: "created", actor: "coordinator", body: "Summarize last week's support emails." },
      { type: "assigned", actor: "coordinator", body: "Assigned to qa-worker-claude" },
    ],
  },
  {
    title: "Refactor the billing module and add tests",
    status: "in_progress",
    summary: "Refactor the billing module, keep behavior, add unit tests.",
    priority: "high",
    worker: { type: "daytona_pi", id: "qa-worker-daytona" },
    ageMinutes: 90,
    events: [
      { type: "created", actor: "coordinator", body: "Refactor the billing module." },
      { type: "assigned", actor: "coordinator", body: "Assigned to qa-worker-daytona" },
      { type: "status_update", actor: "worker", body: "Claimed, reading the module" },
      { type: "comment", actor: "worker", body: "Found 3 duplicated tax helpers." },
      { type: "follow_up", actor: "coordinator", body: "Also cover refunds in the tests." },
    ],
  },
  {
    title: "Migrate staging DB to Postgres 17",
    status: "blocked",
    summary: "Migrate the staging database to Postgres 17.",
    priority: "medium",
    worker: { type: "local_pi", id: "qa-worker-pi" },
    ageMinutes: 240,
    events: [
      { type: "created", actor: "coordinator", body: "Migrate staging DB to Postgres 17." },
      { type: "assigned", actor: "coordinator", body: "Assigned to qa-worker-pi" },
      { type: "status_update", actor: "worker", body: "Claimed" },
      { type: "status_update", actor: "worker", body: "Blocked: need the staging admin password." },
    ],
  },
  {
    title: "Write changelog for sprint 41",
    status: "completed",
    summary: "Write the changelog for sprint 41 from merged PRs.",
    priority: null,
    worker: { type: "local_claude", id: "qa-worker-claude" },
    ageMinutes: 1440,
    result: {
      summary: "Changelog written: 14 entries across 3 sections.",
      url: "https://example.com/changelog/41",
    },
    events: [
      { type: "created", actor: "coordinator", body: "Write changelog for sprint 41." },
      { type: "assigned", actor: "coordinator", body: "Assigned to qa-worker-claude" },
      { type: "status_update", actor: "worker", body: "Claimed" },
      { type: "result", actor: "worker", body: "Changelog written: 14 entries." },
    ],
  },
  {
    title: "Fix flaky checkout e2e test",
    status: "failed",
    summary: "Find and fix the flaky checkout e2e test.",
    priority: "high",
    worker: { type: "daytona_pi", id: "qa-worker-daytona" },
    ageMinutes: 2880,
    error: "Sandbox timed out after 30m without reproducing the flake.",
    events: [
      { type: "created", actor: "coordinator", body: "Fix flaky checkout e2e test." },
      { type: "assigned", actor: "coordinator", body: "Assigned to qa-worker-daytona" },
      { type: "status_update", actor: "worker", body: "Claimed" },
      { type: "error", actor: "worker", body: "Sandbox timed out after 30m." },
    ],
  },
  {
    title: "Rename the Q3 roadmap doc",
    status: "cancelled",
    summary: "Rename the Q3 roadmap doc to match the new naming scheme.",
    priority: "low",
    worker: null,
    ageMinutes: 4320,
    events: [
      { type: "created", actor: "coordinator", body: "Rename the Q3 roadmap doc." },
      { type: "system", actor: "system", body: "Cancelled by requester." },
    ],
  },
];

interface QaMemory {
  readonly type: MemoryEntryType;
  readonly title: string;
  readonly content: string;
  readonly ageMinutes: number;
  /** Index into QA_TICKETS this entry links to. */
  readonly ticket?: number;
  readonly worker?: string;
}

const QA_MEMORY: ReadonlyArray<QaMemory> = [
  {
    type: "manual",
    title: "Brand voice guide",
    content: "Friendly, concise, no jargon. Use sentence case for headings.",
    ageMinutes: 10080,
  },
  {
    type: "note",
    title: "Deploy window",
    content: "Production deploys only Tue/Thu 10:00-16:00 UTC.",
    ageMinutes: 7200,
  },
  {
    type: "email_summary",
    title: "Support digest: week 44",
    content: "Top themes: login loops (12), invoice PDF missing (7), slow dashboard (5).",
    ageMinutes: 2000,
  },
  {
    type: "status_update",
    title: "Sprint 41 status",
    content: "14 of 16 stories done. Billing refactor carried over.",
    ageMinutes: 1500,
  },
  {
    type: "worker_result",
    title: "Sprint 41 changelog",
    content: "Changelog written: 14 entries across Features, Fixes, Chores.",
    ageMinutes: 1400,
    ticket: 4,
    worker: "qa-worker-claude",
  },
  {
    type: "worker_note",
    title: "Billing module findings",
    content:
      "Three duplicated tax helpers in billing/tax.ts, billing/invoice.ts, billing/refund.ts.",
    ageMinutes: 60,
    ticket: 2,
    worker: "qa-worker-daytona",
  },
  {
    type: "worker_note",
    title: "Checkout flake analysis",
    content: "Could not reproduce in sandbox. Suspect network race in payment iframe.",
    ageMinutes: 2800,
    ticket: 5,
    worker: "qa-worker-daytona",
  },
  {
    type: "note",
    title: "Staging access",
    content: "Staging admin credentials live in the team vault under 'staging-db'.",
    ageMinutes: 200,
    ticket: 3,
  },
];

const ALL_STATUSES: ReadonlyArray<Ticket["status"]> = [
  "open",
  "assigned",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

/**
 * Seeds sample tickets (every status, with events) and memory entries (every type) for QA of
 * the dashboard. Idempotent: skips tickets and memory whose title already exists in the project.
 */
export const seedQaData = (projectId: string) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const memory = yield* MemoryRepository;
    const ids = yield* IdGenerator;

    const existingTickets = (yield* tickets.listByStatus(ALL_STATUSES)).filter(
      (t) => t.projectId === projectId,
    );
    const existingMemory = yield* memory.list(projectId);
    const now = Date.now();
    const iso = (ageMinutes: number, offsetMinutes = 0) =>
      new Date(now - (ageMinutes - offsetMinutes) * 60_000).toISOString();

    const ticketIds: Array<string> = [];
    let newTickets = 0;
    for (const q of QA_TICKETS) {
      const found = existingTickets.find((t) => t.title === q.title);
      if (found) {
        ticketIds.push(found.id);
        continue;
      }
      const id = yield* ids.next;
      ticketIds.push(id);
      newTickets++;
      const terminal =
        q.status === "completed" || q.status === "failed" || q.status === "cancelled";
      const started = q.status === "open" || q.status === "assigned" ? null : iso(q.ageMinutes, 2);
      const last = iso(q.ageMinutes, q.events.length);
      yield* tickets.insert({
        id,
        projectId,
        status: q.status,
        title: q.title,
        intent: "new_request",
        inputSummary: q.summary,
        priority: q.priority,
        workerType: q.worker?.type ?? null,
        workerId: q.worker?.id ?? null,
        result: q.result ?? null,
        error: q.error ?? null,
        createdAt: iso(q.ageMinutes),
        assignedAt: q.worker ? iso(q.ageMinutes, 1) : null,
        startedAt: started,
        lastActivityAt: last,
        completedAt: terminal ? last : null,
        updatedAt: last,
      });
      let offset = 0;
      for (const e of q.events) {
        yield* tickets.appendEvent({
          id: yield* ids.next,
          ticketId: id,
          type: e.type,
          actor: e.actor,
          actorId: e.actor === "worker" ? (q.worker?.id ?? null) : null,
          body: e.body,
          payload: null,
          createdAt: iso(q.ageMinutes, offset++),
        });
      }
    }

    let newMemory = 0;
    for (const m of QA_MEMORY) {
      if (existingMemory.some((e) => e.title === m.title)) continue;
      newMemory++;
      yield* memory.insert({
        id: yield* ids.next,
        projectId,
        ticketId: m.ticket === undefined ? null : (ticketIds[m.ticket] ?? null),
        type: m.type,
        title: m.title,
        content: m.content,
        sourceMetadata: null,
        createdBy: m.worker ?? null,
        createdAt: iso(m.ageMinutes),
      });
    }

    return { tickets: newTickets, memory: newMemory };
  });

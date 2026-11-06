import type {
  ActivityFeed,
  ActivityTicket,
  ActivityWorker,
  ChannelType,
  TicketEvent,
  TicketOrigin,
  TicketStatus,
} from "@project-os/contracts";
import { nodeId, type WorkerSlot } from "./iso.ts";

/** A person on a packet: initials on a coloured disc, with a channel badge. */
export interface Identity {
  readonly name: string;
  readonly initials: string;
  readonly color: string;
  readonly channel: ChannelType;
}

const PALETTE = ["#5865d8", "#c8417a", "#16907d", "#b9661a", "#5d6b80", "#7a52c7", "#2f7fc1"];

export const identityOf = (origin: TicketOrigin): Identity => {
  const name = origin.sender.name ?? origin.sender.email ?? origin.sender.id;
  const words = name.split(/[\s._@-]+/).filter(Boolean);
  const initials =
    words
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?";
  let hash = 0;
  for (const ch of origin.sender.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { name, initials, color: PALETTE[hash % PALETTE.length]!, channel: origin.channelType };
};

/** Short label for a ticket chip. */
export const ticketLabel = (id: string): string => `#${id.replace(/[^a-z0-9]/gi, "").slice(-4)}`;

/** Coordinator parts that light up while they work. */
export type Module = "jev" | "tickets" | "mcp" | "pi";

export type Packet =
  | { readonly kind: "message"; readonly who: Identity }
  | { readonly kind: "reply"; readonly who: Identity | null }
  | {
      readonly kind: "ticket";
      readonly ticketId: string;
      readonly tone: "work" | "done" | "failed";
    }
  | { readonly kind: "call"; readonly label: string };

/** One beat of a ticket's story on the map. Beats of one ticket play in order. */
export type Step =
  | { readonly type: "travel"; readonly from: string; readonly to: string; readonly packet: Packet }
  | { readonly type: "flash"; readonly module: Module }
  | { readonly type: "status"; readonly ticketId: string; readonly status: TicketStatus };

export interface Story {
  readonly ticketId: string;
  readonly steps: ReadonlyArray<Step>;
}

/** What the map shows. `status` is the last status the animation reached for each ticket. */
export interface MapModel {
  readonly tickets: ReadonlyMap<string, ActivityTicket>;
  readonly workers: ReadonlyArray<ActivityWorker>;
  readonly seenEvents: ReadonlySet<string>;
  /** Newest first, for the activity list beside the map. */
  readonly recent: ReadonlyArray<TicketEvent>;
  readonly since: string | null;
}

export const emptyModel: MapModel = {
  tickets: new Map(),
  workers: [],
  seenEvents: new Set(),
  recent: [],
  since: null,
};

const RECENT_MAX = 30;

const ACTIVE: ReadonlyArray<TicketStatus> = ["open", "assigned", "in_progress", "blocked"];

/** Channels drawn on the map: Discord and email always, chat once a ticket comes from it. */
export const channelsOf = (tickets: Iterable<ActivityTicket>): ChannelType[] => {
  const seen = new Set<ChannelType>(["discord", "email"]);
  for (const t of tickets) {
    if (t.origin) seen.add(t.origin.channelType);
    if (t.replyChannel) seen.add(t.replyChannel);
  }
  return (["discord", "email", "chat"] as const).filter((c) => seen.has(c));
};

/**
 * Worker blocks: every Worker that has checked in, plus any worker a live ticket is assigned to
 * that has not checked in yet (shown by id, or by type when the ticket names no worker).
 */
export const workerSlots = (
  workers: ReadonlyArray<ActivityWorker>,
  tickets: Iterable<ActivityTicket>,
): WorkerSlot[] => {
  const slots = new Map<string, WorkerSlot>(
    workers.map((w) => [w.id, { id: w.id, workerType: w.workerType }]),
  );
  for (const t of tickets) {
    if (!ACTIVE.includes(t.status)) continue;
    const key = workerKey(t);
    if (key && !slots.has(key)) slots.set(key, { id: key, workerType: t.workerType });
  }
  return [...slots.values()].sort((a, b) => a.id.localeCompare(b.id));
};

/** The worker block a ticket belongs to, if it has been assigned. */
export const workerKey = (t: Pick<ActivityTicket, "workerId" | "workerType">): string | null =>
  t.workerId ?? (t.workerType ? `any ${t.workerType}` : null);

const MCP_LABEL: Partial<Record<TicketEvent["type"], string>> = {
  status_update: "status_update",
  comment: "comment",
  result: "result",
  error: "error",
};

/** What a worker sends back when its ticket leaves `in_progress`. */
const FINISH: Partial<Record<TicketStatus, (ticketId: string) => Packet>> = {
  completed: (ticketId) => ({ kind: "ticket", ticketId, tone: "done" }),
  failed: (ticketId) => ({ kind: "ticket", ticketId, tone: "failed" }),
  blocked: () => ({ kind: "call", label: "blocked" }),
};

const travel = (from: string, to: string, packet: Packet): Step => ({
  type: "travel",
  from,
  to,
  packet,
});

const inboundSteps = (origin: TicketOrigin | null): Step[] => {
  if (!origin) return [];
  const who = identityOf(origin);
  return [
    travel(nodeId.channel(origin.channelType), nodeId.adapter(origin.channelType), {
      kind: "message",
      who,
    }),
    travel(nodeId.adapter(origin.channelType), nodeId.coordinator, { kind: "message", who }),
    { type: "flash", module: "jev" },
  ];
};

const senderOrigin = (event: TicketEvent, fallback: TicketOrigin | null): TicketOrigin | null => {
  const payload = event.payload as { sender?: TicketOrigin["sender"] } | null;
  if (!payload?.sender || !fallback) return fallback;
  return { channelType: fallback.channelType, sender: payload.sender };
};

/** The story of one ticket between two reads of the feed. */
const storyOf = (
  ticket: ActivityTicket,
  before: TicketStatus | undefined,
  events: ReadonlyArray<TicketEvent>,
): Step[] => {
  const steps: Step[] = [];
  const worker = workerKey(ticket);
  const workerNode = worker ? nodeId.worker(worker) : null;
  let status = before;
  const setStatus = (s: TicketStatus) => {
    steps.push({ type: "status", ticketId: ticket.id, status: s });
    status = s;
  };

  for (const e of events.filter((e) => e.type === "created" || e.type === "assigned")) {
    if (e.type === "created") {
      steps.push(...inboundSteps(ticket.origin), { type: "flash", module: "tickets" });
      setStatus("open");
    } else {
      steps.push({ type: "flash", module: "tickets" });
      setStatus("assigned");
    }
  }

  const started = ticket.startedAt !== null && ticket.status !== "assigned";
  if (
    workerNode &&
    started &&
    (status === undefined || status === "open" || status === "assigned")
  ) {
    steps.push(
      travel(workerNode, nodeId.coordinator, { kind: "call", label: "ticket_claim" }),
      { type: "flash", module: "mcp" },
      travel(nodeId.coordinator, workerNode, { kind: "ticket", ticketId: ticket.id, tone: "work" }),
    );
    setStatus("in_progress");
  }

  for (const e of events) {
    if (e.type === "follow_up") {
      steps.push(...inboundSteps(senderOrigin(e, ticket.origin)), {
        type: "flash",
        module: "tickets",
      });
      if (workerNode && status === "in_progress")
        steps.push(travel(nodeId.coordinator, workerNode, { kind: "call", label: "follow_up" }));
    } else if (e.actor === "worker" && workerNode && MCP_LABEL[e.type]) {
      steps.push(
        travel(workerNode, nodeId.coordinator, { kind: "call", label: MCP_LABEL[e.type]! }),
        {
          type: "flash",
          module: "mcp",
        },
      );
    }
  }

  if (ticket.status !== status) {
    const finish = FINISH[ticket.status];
    if (finish && workerNode && status === "in_progress")
      steps.push(travel(workerNode, nodeId.coordinator, finish(ticket.id)));
    setStatus(ticket.status);
    if (ticket.status === "completed" && ticket.replyChannel) {
      const who = ticket.origin ? identityOf(ticket.origin) : null;
      const adapter = nodeId.adapter(ticket.replyChannel);
      steps.push(
        { type: "flash", module: "pi" },
        travel(nodeId.coordinator, adapter, { kind: "reply", who }),
        travel(adapter, nodeId.channel(ticket.replyChannel), { kind: "reply", who }),
      );
    }
  }
  return steps;
};

/**
 * Folds one read of `GET /activity` into the model. The first read is a baseline and tells no
 * stories; later reads turn each changed ticket into the steps that got it to its new status.
 */
export const applyFeed = (
  model: MapModel,
  feed: ActivityFeed,
): { model: MapModel; stories: Story[] } => {
  const baseline = model.since === null;
  const fresh = feed.events.filter((e) => !model.seenEvents.has(e.id));
  const seenEvents = new Set(model.seenEvents);
  for (const e of fresh) seenEvents.add(e.id);

  const tickets = new Map(model.tickets);
  const stories: Story[] = [];
  const byTicket = new Map<string, TicketEvent[]>();
  for (const e of fresh) byTicket.set(e.ticketId, [...(byTicket.get(e.ticketId) ?? []), e]);

  const changed = [...feed.tickets].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const t of changed) {
    const before = model.tickets.get(t.id);
    tickets.set(t.id, t);
    if (baseline) continue;
    if (before && before.updatedAt === t.updatedAt && !byTicket.has(t.id)) continue;
    const steps = storyOf(t, before?.status, byTicket.get(t.id) ?? []);
    if (steps.length > 0) stories.push({ ticketId: t.id, steps });
  }
  const recent = [...fresh].reverse().concat(model.recent).slice(0, RECENT_MAX);
  return {
    model: { tickets, workers: feed.workers, seenEvents, recent, since: feed.now },
    stories,
  };
};

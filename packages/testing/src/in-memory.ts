import {
  AgentRuntime,
  ChannelCreateFailed,
  ChannelGateway,
  claimTicket,
  IdGenerator,
  IntentClassifier,
  KeyValueStore,
  MemoryRepository,
  ProjectNotFound,
  ProjectRepository,
  ProjectSourceRepository,
  Scheduler,
  SourceAlreadyLinked,
  SourceNotFound,
  TicketNotFound,
  TicketRepository,
  transitionTicket,
  WorkerLauncher,
  WorkerNotFound,
  WorkerRepository,
  type Project,
  type ProjectSource,
  type Ticket,
  type TicketEvent,
  type Worker,
} from "@project-os/core";
import type {
  CreateChannelInstruction,
  MemoryEntry,
  ReplyInstruction,
} from "@project-os/contracts";
import { Effect, Layer } from "effect";

const byKey = <A>(items: Iterable<A>, key: (a: A) => string): A[] =>
  [...items].sort((a, b) => key(a).localeCompare(key(b)));

export const TicketRepositoryInMemory = Layer.sync(TicketRepository, () => {
  const tickets = new Map<string, Ticket>();
  const events = new Map<string, TicketEvent[]>();
  const find = (id: string) => {
    const t = tickets.get(id);
    return t ? Effect.succeed(t) : Effect.fail(new TicketNotFound({ ticketId: id }));
  };
  const put = (t: Ticket) => {
    tickets.set(t.id, t);
    return t;
  };
  return {
    insert: (ticket) => Effect.sync(() => put(ticket)),
    get: find,
    listAssigned: (workerId) =>
      Effect.sync(() =>
        byKey(
          [...tickets.values()].filter((t) => t.status === "assigned" && t.workerId === workerId),
          (t) => t.assignedAt ?? t.createdAt,
        ),
      ),
    listByStatus: (statuses) =>
      Effect.sync(() => [...tickets.values()].filter((t) => statuses.includes(t.status))),
    assign: (ticketId, worker, at) =>
      Effect.flatMap(find(ticketId), (t) =>
        Effect.map(transitionTicket(t, "assigned", at), (a) =>
          put({ ...a, workerType: worker.workerType, workerId: worker.workerId }),
        ),
      ),
    claim: (ticketId, workerId, at) =>
      Effect.flatMap(find(ticketId), (t) => Effect.map(claimTicket(t, workerId, at), put)),
    updateStatus: (ticketId, to, at, extra) =>
      Effect.flatMap(find(ticketId), (t) => Effect.map(transitionTicket(t, to, at, extra), put)),
    appendEvent: (event) =>
      Effect.flatMap(find(event.ticketId), (t) =>
        Effect.sync(() => {
          events.set(t.id, [...(events.get(t.id) ?? []), event]);
          put({ ...t, lastActivityAt: event.createdAt, updatedAt: event.createdAt });
          return event;
        }),
      ),
    listEvents: (ticketId, limit) =>
      Effect.flatMap(find(ticketId), () =>
        Effect.sync(() => {
          const all = events.get(ticketId) ?? [];
          return limit === undefined ? all : all.slice(-limit);
        }),
      ),
  };
});

export const ProjectRepositoryInMemory = Layer.sync(ProjectRepository, () => {
  const projects = new Map<string, Project>();
  return {
    insert: (project) =>
      Effect.sync(() => {
        projects.set(project.id, project);
        return project;
      }),
    get: (id) => {
      const p = projects.get(id);
      return p ? Effect.succeed(p) : Effect.fail(new ProjectNotFound({ projectId: id }));
    },
    list: Effect.sync(() => [...projects.values()]),
  };
});

export const ProjectSourceRepositoryInMemory = Layer.sync(ProjectSourceRepository, () => {
  const sources = new Map<string, ProjectSource>();
  const find = (type: string, externalId: string) =>
    [...sources.values()].find((s) => s.type === type && s.externalId === externalId);
  return {
    insert: (source) =>
      Effect.suspend(() => {
        const existing = find(source.type, source.externalId);
        if (existing) {
          return Effect.fail(
            new SourceAlreadyLinked({
              type: source.type,
              externalId: source.externalId,
              projectId: existing.projectId,
            }),
          );
        }
        sources.set(source.id, source);
        return Effect.succeed(source);
      }),
    findByExternal: (type, externalId) => Effect.sync(() => find(type, externalId)),
    listByProject: (projectId) =>
      Effect.sync(() => [...sources.values()].filter((s) => s.projectId === projectId)),
    setDefaultResponse: (projectId, sourceId) =>
      Effect.suspend(() => {
        const target = sources.get(sourceId);
        if (!target || target.projectId !== projectId) {
          return Effect.fail(new SourceNotFound({ sourceId }));
        }
        for (const s of sources.values()) {
          if (s.projectId === projectId) {
            sources.set(s.id, { ...s, isDefaultResponse: s.id === sourceId });
          }
        }
        return Effect.succeed(sources.get(sourceId)!);
      }),
  };
});

export const MemoryRepositoryInMemory = Layer.sync(MemoryRepository, () => {
  const entries: MemoryEntry[] = [];
  const forProject = (projectId: string) =>
    entries.filter((e) => e.projectId === projectId).reverse();
  return {
    insert: (entry) =>
      Effect.sync(() => {
        entries.push(entry);
        return entry;
      }),
    list: (projectId, options) =>
      Effect.sync(() =>
        forProject(projectId)
          .filter((e) => options?.type === undefined || e.type === options.type)
          .slice(0, options?.limit),
      ),
    search: (projectId, query, limit) =>
      Effect.sync(() => {
        const q = query.toLowerCase();
        return forProject(projectId)
          .filter((e) => `${e.title}\n${e.content}`.toLowerCase().includes(q))
          .slice(0, limit);
      }),
  };
});

export const WorkerRepositoryInMemory = Layer.sync(WorkerRepository, () => {
  const workers = new Map<string, Worker>();
  return {
    heartbeat: ({ workerId, workerType, ticketId, at }) =>
      Effect.sync(() => {
        const prev = workers.get(workerId);
        const next: Worker = {
          id: workerId,
          workerType,
          currentTicketId: ticketId,
          lastSeenAt: at,
          createdAt: prev?.createdAt ?? at,
        };
        workers.set(workerId, next);
        return next;
      }),
    get: (id) => {
      const w = workers.get(id);
      return w ? Effect.succeed(w) : Effect.fail(new WorkerNotFound({ workerId: id }));
    },
    list: Effect.sync(() => [...workers.values()]),
  };
});

export const KeyValueStoreInMemory = Layer.sync(KeyValueStore, () => {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string) => {
    const hit = store.get(key);
    if (hit && hit.expiresAt !== null && hit.expiresAt <= Date.now()) store.delete(key);
    return store.get(key);
  };
  const write = (key: string, value: string, ttlSeconds?: number) =>
    store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  return {
    get: (key) => Effect.sync(() => live(key)?.value),
    set: (key, value, options) => Effect.sync(() => void write(key, value, options?.ttlSeconds)),
    setIfAbsent: (key, value, options) =>
      Effect.sync(() => {
        if (live(key)) return false;
        write(key, value, options?.ttlSeconds);
        return true;
      }),
    delete: (key) => Effect.sync(() => void store.delete(key)),
  };
});

/**
 * Records every reply sent (`sent`) and channel created (`created`). Created channels get
 * ids `chan-1`, `chan-2`, …; pass `failCreate` to make channel creation fail with that message.
 */
export const makeChannelGatewayRecording = (options?: { readonly failCreate?: string }) => {
  const sent: ReplyInstruction[] = [];
  const created: CreateChannelInstruction[] = [];
  return {
    sent,
    created,
    layer: Layer.succeed(ChannelGateway, {
      send: (reply) => Effect.sync(() => void sent.push(reply)),
      createChannel: (request) =>
        options?.failCreate !== undefined
          ? Effect.fail(
              new ChannelCreateFailed({
                channelType: request.channelType,
                message: options.failCreate,
              }),
            )
          : Effect.sync(() => {
              created.push(request);
              return { channelId: `chan-${created.length}`, name: request.name };
            }),
    }),
  };
};

/** Scheduler that never fires on its own: tests call the returned task directly. */
export const SchedulerNoop = Layer.succeed(Scheduler, {
  every: () => Effect.succeed(Effect.void),
});

export const IntentClassifierFake = (intent = "general") =>
  Layer.succeed(IntentClassifier, {
    classify: () => Effect.succeed({ intent, confidence: 1 }),
  });

export const AgentRuntimeEcho = Layer.succeed(AgentRuntime, {
  respond: ({ prompt }) => Effect.succeed(prompt),
});

export const WorkerLauncherNoop = Layer.succeed(WorkerLauncher, {
  launch: () => Effect.void,
});

/** Sequential ids: `id-1`, `id-2`, … */
export const IdGeneratorSequential = Layer.sync(IdGenerator, () => {
  let n = 0;
  return { next: Effect.sync(() => `id-${++n}`) };
});

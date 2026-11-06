import {
  AgentRuntime,
  ChannelCreateFailed,
  ChannelGateway,
  claimTicket,
  IdGenerator,
  IntentClassifier,
  KeyValueStore,
  MemoryRepository,
  NotConnected,
  type Person,
  ProjectNotFound,
  ProjectRepository,
  ProjectSourceRepository,
  ReactionFailed,
  Scheduler,
  SourceAliasTaken,
  SourceAlreadyLinked,
  SourceNotFound,
  PromptSendFailed,
  ThreadCreateFailed,
  TicketNotFound,
  TicketRepository,
  transitionTicket,
  UserConnections,
  WorkerNotFound,
  WorkerRepository,
  type Project,
  type ProjectSource,
  type Ticket,
  type TicketEvent,
  type TicketThread,
  type Worker,
} from "@project-os/core";
import {
  type ConnectionProvider,
  CONNECTION_PROVIDERS,
  type CreateChannelInstruction,
  type CreateThreadInstruction,
  type PromptInstruction,
  type MemoryEntry,
  type ReactInstruction,
  type ReplyInstruction,
} from "@project-os/contracts";
import { Effect, Layer } from "effect";

const byKey = <A>(items: Iterable<A>, key: (a: A) => string): A[] =>
  [...items].sort((a, b) => key(a).localeCompare(key(b)));

export const TicketRepositoryInMemory = Layer.sync(TicketRepository, () => {
  const tickets = new Map<string, Ticket>();
  const events = new Map<string, TicketEvent[]>();
  const threads = new Map<string, TicketThread>();
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
    linkThread: (thread) =>
      Effect.flatMap(find(thread.ticketId), () =>
        Effect.sync(() => {
          threads.set(thread.ticketId, thread);
          return thread;
        }),
      ),
    findThread: (ticketId) => Effect.sync(() => threads.get(ticketId)),
    findByThread: (channelType, threadId) =>
      Effect.sync(() =>
        [...threads.values()].find((t) => t.channelType === channelType && t.threadId === threadId),
      ),
    listEventsSince: (since, limit) =>
      Effect.sync(() =>
        byKey(
          [...events.values()].flat().filter((e) => e.createdAt >= since),
          (e) => e.createdAt,
        ).slice(-limit),
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
    update: (project) =>
      projects.has(project.id)
        ? Effect.sync(() => {
            projects.set(project.id, project);
            return project;
          })
        : Effect.fail(new ProjectNotFound({ projectId: project.id })),
  };
});

export const ProjectSourceRepositoryInMemory = Layer.sync(ProjectSourceRepository, () => {
  const sources = new Map<string, ProjectSource>();
  const find = (type: string, externalId: string) =>
    [...sources.values()].find((s) => s.type === type && s.externalId === externalId);
  return {
    insert: (source) =>
      Effect.suspend((): Effect.Effect<ProjectSource, SourceAlreadyLinked | SourceAliasTaken> => {
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
        if (
          [...sources.values()].some(
            (s) => s.projectId === source.projectId && s.alias === source.alias,
          )
        ) {
          return Effect.fail(
            new SourceAliasTaken({ projectId: source.projectId, alias: source.alias }),
          );
        }
        sources.set(source.id, source);
        return Effect.succeed(source);
      }),
    update: (projectId, sourceId, patch) =>
      Effect.suspend((): Effect.Effect<ProjectSource, SourceNotFound | SourceAliasTaken> => {
        const target = sources.get(sourceId);
        if (!target || target.projectId !== projectId) {
          return Effect.fail(new SourceNotFound({ sourceId }));
        }
        const { alias } = patch;
        if (
          alias !== undefined &&
          [...sources.values()].some(
            (s) => s.projectId === projectId && s.alias === alias && s.id !== sourceId,
          )
        ) {
          return Effect.fail(new SourceAliasTaken({ projectId, alias }));
        }
        const updated = { ...target, ...patch };
        sources.set(sourceId, updated);
        return Effect.succeed(updated);
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
 * Records every reply sent (`sent`), channel created (`created`), thread opened (`threads`),
 * reaction (`reactions`) and prompt posted (`prompts`, message ids `prompt-msg-1`, …).
 * Created channels get ids `chan-1`, …, threads `thread-1`, …; pass `failCreate` /
 * `failThread` to make channel / thread creation fail with that message.
 */
export const makeChannelGatewayRecording = (options?: {
  readonly failCreate?: string;
  readonly failThread?: string;
  readonly failReact?: string;
  readonly failPrompt?: string;
}) => {
  const sent: ReplyInstruction[] = [];
  const created: CreateChannelInstruction[] = [];
  const threads: CreateThreadInstruction[] = [];
  const reactions: ReactInstruction[] = [];
  const prompts: PromptInstruction[] = [];
  return {
    sent,
    created,
    threads,
    reactions,
    prompts,
    layer: Layer.succeed(ChannelGateway, {
      react: (request) =>
        options?.failReact !== undefined
          ? Effect.fail(
              new ReactionFailed({ channelType: request.channelType, message: options.failReact }),
            )
          : Effect.sync(() => void reactions.push(request)),
      ask: (request) =>
        options?.failPrompt !== undefined
          ? Effect.fail(
              new PromptSendFailed({
                channelType: request.channelType,
                message: options.failPrompt,
              }),
            )
          : Effect.sync(() => {
              prompts.push(request);
              return { messageId: `prompt-msg-${prompts.length}` };
            }),
      createThread: (request) =>
        options?.failThread !== undefined
          ? Effect.fail(
              new ThreadCreateFailed({
                channelType: request.channelType,
                message: options.failThread,
              }),
            )
          : Effect.sync(() => {
              threads.push(request);
              return { threadId: `thread-${threads.length}` };
            }),
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

/** Sequential ids: `id-1`, `id-2`, … */
export const IdGeneratorSequential = Layer.sync(IdGenerator, () => {
  let n = 0;
  return { next: Effect.sync(() => `id-${++n}`) };
});

/** Account links held in memory: `link` stands in for a person finishing `/connect`. */
export const makeUserConnectionsInMemory = () => {
  const tokens = new Map<string, string>();
  const key = (p: Person, provider: ConnectionProvider) => `${p.channelType}:${p.id}:${provider}`;
  const layer = Layer.succeed(UserConnections, {
    connectUrl: (p, provider) => Effect.succeed(`http://connect.test/${provider}/${p.id}`),
    list: (p) =>
      Effect.succeed(
        CONNECTION_PROVIDERS.filter((provider) => tokens.has(key(p, provider))).map((provider) => ({
          provider,
          accountId: `acct-${p.id}`,
        })),
      ),
    disconnect: (p, provider) => Effect.succeed(tokens.delete(key(p, provider))),
    accessToken: (p, provider) => {
      const token = tokens.get(key(p, provider));
      return token
        ? Effect.succeed({ accessToken: token, expiresAt: null, scopes: [] })
        : Effect.fail(new NotConnected({ provider, personId: p.id, message: "not linked" }));
    },
  });
  return {
    layer,
    link: (p: Person, provider: ConnectionProvider, token: string) =>
      void tokens.set(key(p, provider), token),
  };
};

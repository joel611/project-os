import {
  AgentRuntime,
  ChannelCreateFailed,
  ChannelDigester,
  ChannelDigestError,
  ChannelMessageRepository,
  type DigestPoint,
  ChannelGateway,
  claimTicket,
  reassignTicket,
  releaseTicket,
  reopenTicket,
  IdGenerator,
  involves,
  IntentClassifier,
  AssetStore,
  AssetStoreFailed,
  KeyValueStore,
  AuditLogRepository,
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
  parseSkillFrontmatter,
  Sidekick,
  SidekickError,
  SkillFetchFailed,
  SkillNotFound,
  SkillRepository,
  SkillSetNameTaken,
  SkillSetNotFound,
  SkillSource,
  type Skill,
  type SkillFile,
  type SkillSet,
  type SidekickToken,
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
  type ChannelMessage,
  type AuditEntry,
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
    release: (ticketId, workerId, at) =>
      Effect.flatMap(find(ticketId), (t) => Effect.map(releaseTicket(t, workerId, at), put)),
    reopen: (ticketId, at) =>
      Effect.flatMap(find(ticketId), (t) => Effect.map(reopenTicket(t, at), put)),
    reassign: (ticketId, worker, at) =>
      Effect.flatMap(find(ticketId), (t) => Effect.map(reassignTicket(t, worker, at), put)),
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
    listInvolving: (person) =>
      Effect.sync(() =>
        byKey(
          [...tickets.values()].filter((t) => involves(t, events.get(t.id) ?? [], person)),
          (t) => t.lastActivityAt,
        ).reverse(),
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
    remove: (projectId, sourceId) =>
      Effect.suspend(() => {
        const target = sources.get(sourceId);
        if (!target || target.projectId !== projectId) {
          return Effect.fail(new SourceNotFound({ sourceId }));
        }
        sources.delete(sourceId);
        return Effect.succeed(target);
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

export const AuditLogRepositoryInMemory = Layer.sync(AuditLogRepository, () => {
  const rows: Array<{ entry: AuditEntry; dedupeKey: string | null; seq: number }> = [];
  let seq = 0;
  return {
    append: (entry, dedupeKey) =>
      Effect.sync(() => {
        const taken = dedupeKey !== undefined && rows.some((r) => r.dedupeKey === dedupeKey);
        if (!taken) rows.push({ entry, dedupeKey: dedupeKey ?? null, seq: ++seq });
        return !taken;
      }),
    list: ({ projectId, workerId, kind, before, limit }) =>
      Effect.sync(() => {
        const page = rows
          .filter((r) => projectId === undefined || r.entry.projectId === projectId)
          .filter((r) => workerId === undefined || r.entry.workerId === workerId)
          .filter((r) => kind === undefined || r.entry.kind === kind)
          .filter((r) => before === undefined || r.seq < before)
          .reverse()
          .slice(0, limit);
        return {
          entries: page.map((r) => r.entry),
          next: page.length < limit ? null : page.at(-1)!.seq,
        };
      }),
    removeBefore: (at) =>
      Effect.sync(() => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.entry.at < at) rows.splice(i, 1);
        return before - rows.length;
      }),
  };
});

export const ChannelMessageRepositoryInMemory = Layer.sync(ChannelMessageRepository, () => {
  const rows: ChannelMessage[] = [];
  const oldestFirst = (list: ChannelMessage[]) =>
    [...list].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  return {
    append: (message) =>
      Effect.sync(() => {
        const taken = rows.some(
          (r) => r.channelType === message.channelType && r.externalId === message.externalId,
        );
        if (!taken) rows.push(message);
        return !taken;
      }),
    pending: Effect.sync(() => {
      const byProject = new Map<string, ChannelMessage[]>();
      for (const r of rows) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
      return [...byProject].map(([projectId, list]) => {
        const sorted = oldestFirst(list);
        return {
          projectId,
          count: sorted.length,
          oldestAt: sorted[0]!.sentAt,
          newestAt: sorted[sorted.length - 1]!.sentAt,
        };
      });
    }),
    list: (projectId, limit) =>
      Effect.sync(() => oldestFirst(rows.filter((r) => r.projectId === projectId)).slice(0, limit)),
    remove: (ids) =>
      Effect.sync(() => {
        const drop = new Set(ids);
        for (let i = rows.length - 1; i >= 0; i--) if (drop.has(rows[i]!.id)) rows.splice(i, 1);
      }),
    removeSentBefore: (at) =>
      Effect.sync(() => {
        let removed = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.sentAt < at) {
            rows.splice(i, 1);
            removed++;
          }
        }
        return removed;
      }),
  };
});

export type ChannelDigestCall = Parameters<typeof ChannelDigester.Service.digest>[0];

/**
 * Channel digester that needs no model: every message saying "decided" or "decision" becomes a
 * decision, and one saying "remember" a note. Records each call; `fail` makes every call fail.
 */
export const makeChannelDigesterRecording = (options?: { readonly fail?: string }) => {
  const calls: ChannelDigestCall[] = [];
  const layer = Layer.succeed(ChannelDigester, {
    digest: (input) =>
      Effect.suspend(() => {
        calls.push(input);
        if (options?.fail !== undefined) {
          return Effect.fail(new ChannelDigestError({ message: options.fail }));
        }
        const points: DigestPoint[] = input.messages.flatMap((m): DigestPoint[] => {
          const type = /\bdecid|\bdecision/i.test(m.content)
            ? "decision"
            : /\bremember\b/i.test(m.content)
              ? "note"
              : undefined;
          return type === undefined || input.known.includes(m.content)
            ? []
            : [
                {
                  type,
                  title: m.content,
                  content: `${m.sender}: ${m.content}`,
                  messageIds: [m.id],
                },
              ];
        });
        return Effect.succeed(points);
      }),
  });
  return { layer, calls };
};

export const WorkerRepositoryInMemory = Layer.sync(WorkerRepository, () => {
  const workers = new Map<string, Worker>();
  const secrets = new Map<string, string>(); // secretHash → worker id
  return {
    heartbeat: ({ workerId, workerType, ticketId, at }) =>
      Effect.sync(() => {
        const prev = workers.get(workerId);
        const next: Worker = {
          id: workerId,
          workerType,
          ownerChannelType: prev?.ownerChannelType ?? null,
          ownerId: prev?.ownerId ?? null,
          registered: prev?.registered ?? false,
          name: prev?.name ?? null,
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
    register: ({ id, workerType, owner, name, secretHash, at }) =>
      Effect.sync(() => {
        const worker: Worker = {
          id,
          workerType,
          ownerChannelType: owner?.channelType ?? null,
          ownerId: owner?.id ?? null,
          registered: true,
          name,
          currentTicketId: null,
          lastSeenAt: new Date(0).toISOString(),
          createdAt: at,
        };
        workers.set(id, worker);
        secrets.set(secretHash, id);
        return worker;
      }),
    findBySecretHash: (secretHash) =>
      Effect.sync(() => {
        const id = secrets.get(secretHash);
        return id === undefined ? undefined : workers.get(id);
      }),
    listByOwner: (channelType, ownerId) =>
      Effect.sync(() =>
        [...workers.values()].filter(
          (w) => w.ownerChannelType === channelType && w.ownerId === ownerId,
        ),
      ),
    remove: (id) =>
      Effect.sync(() => {
        for (const [hash, wid] of secrets) if (wid === id) secrets.delete(hash);
        return workers.delete(id);
      }),
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
      resolveAttachments: () => Effect.succeed({ attachments: [] }),
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

/** The signature `makeAssetStoreRecording` accepts on download and upload links. */
export const VALID_ASSET_SIG = "valid";

/**
 * `AssetStore` that records what `ingest` was asked to copy (key to source URL) and links
 * whatever it holds as `https://assets.test/<key>`. Bytes written by `put` can be read back with
 * `get`. A link is valid only with `sig=VALID_ASSET_SIG`. `fail` makes every write fail with it.
 */
export const makeAssetStoreRecording = (options?: { readonly fail?: string }) => {
  const stored = new Map<string, string>();
  const files = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  return {
    stored,
    layer: Layer.succeed(AssetStore, {
      ingest: ({ key, url }) =>
        options?.fail === undefined
          ? Effect.sync(() => void stored.set(key, url))
          : Effect.fail(new AssetStoreFailed({ message: options.fail })),
      get: (key) => {
        const file = files.get(key);
        return Effect.succeed(
          file && {
            body: new Response(file.bytes).body!,
            contentType: file.contentType,
            size: file.bytes.byteLength,
          },
        );
      },
      link: (key) => Effect.succeed(stored.has(key) ? `https://assets.test/${key}` : undefined),
      verify: (_key, _expires, sig) => Effect.succeed(sig === VALID_ASSET_SIG),
      uploadLink: (key) =>
        Effect.succeed(
          options?.fail === undefined
            ? { url: `https://assets.test/upload/${key}`, expiresInSeconds: 3600 }
            : undefined,
        ),
      verifyUpload: (_key, _expires, sig) => Effect.succeed(sig === VALID_ASSET_SIG),
      put: ({ key, body, contentType }) =>
        options?.fail === undefined
          ? Effect.promise(async () => {
              files.set(key, {
                bytes: await new Response(body).arrayBuffer(),
                contentType,
              });
              stored.set(key, "upload");
            })
          : Effect.fail(new AssetStoreFailed({ message: options.fail })),
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

export interface SidekickCall {
  readonly ticketId: string;
  readonly prompt: string;
  readonly requestId: string | undefined;
  /** What the token lookup for the probed provider returned this turn. Unset: not probed. */
  readonly token: SidekickToken | undefined;
}

/**
 * Sidekick that answers `sidekick: <prompt>` and records each turn. With `probe` it asks for
 * that provider's token during the turn, as a tool would. `fail` makes every turn fail with
 * that message.
 */
export const makeSidekickRecording = (options?: {
  readonly fail?: string;
  readonly probe?: ConnectionProvider;
}) => {
  const calls: SidekickCall[] = [];
  const layer = Layer.succeed(Sidekick, {
    answer: (input) =>
      options?.fail === undefined
        ? Effect.promise(async () => {
            calls.push({
              ticketId: input.ticketId,
              prompt: input.prompt,
              requestId: input.requestId,
              token: options?.probe ? await input.token(options.probe) : undefined,
            });
            return `sidekick: ${input.prompt}`;
          })
        : Effect.fail(new SidekickError({ message: options.fail })),
  });
  return { layer, calls };
};

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

export const SkillRepositoryInMemory = Layer.sync(SkillRepository, () => {
  const sets = new Map<string, SkillSet>();
  const stored = new Map<string, { skill: Skill }>();
  const inSet = (setId: string) => [...stored.values()].filter((e) => e.skill.skillSetId === setId);
  const takenBy = (name: string) => [...sets.values()].find((s) => s.name === name);
  const getSet = (id: string): Effect.Effect<SkillSet, SkillSetNotFound> => {
    const set = sets.get(id);
    return set ? Effect.succeed(set) : Effect.fail(new SkillSetNotFound({ skillSetId: id }));
  };
  return {
    listSets: Effect.sync(() => [...sets.values()]),
    getSet,
    insertSet: (set) =>
      Effect.suspend(() => {
        if (takenBy(set.name)) return Effect.fail(new SkillSetNameTaken({ setName: set.name }));
        sets.set(set.id, set);
        return Effect.succeed(set);
      }),
    updateSet: (id, patch) =>
      Effect.gen(function* () {
        const current = yield* getSet(id);
        if (patch.name !== undefined && takenBy(patch.name)?.id !== undefined) {
          if (takenBy(patch.name)!.id !== id) {
            return yield* new SkillSetNameTaken({ setName: patch.name });
          }
        }
        const next = { ...current, ...patch };
        sets.set(id, next);
        return next;
      }),
    deleteSet: (id) =>
      getSet(id).pipe(
        Effect.map(() => {
          sets.delete(id);
          for (const e of inSet(id)) stored.delete(e.skill.id);
        }),
      ),
    listSkills: (setId) =>
      Effect.sync(() =>
        inSet(setId)
          .map((e) => e.skill)
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    getSkill: (id) => {
      const entry = stored.get(id);
      return entry ? Effect.succeed(entry.skill) : Effect.fail(new SkillNotFound({ skillId: id }));
    },
    upsertSkill: (skill) =>
      Effect.sync(() => {
        const same = inSet(skill.skillSetId).find(
          (e) => e.skill.source === skill.source && e.skill.slug === skill.slug,
        );
        const next = { ...skill, id: same?.skill.id ?? skill.id };
        stored.set(next.id, { skill: next });
        return next;
      }),
    removeSkill: (id) =>
      Effect.suspend(() =>
        stored.delete(id) ? Effect.void : Effect.fail(new SkillNotFound({ skillId: id })),
      ),
  };
});

/**
 * A `SkillSource` over a map of `owner/repo` to its skill folders. Each folder's tree SHA is
 * its `sha`; change it with `publish` to look like an upstream update.
 */
export const makeSkillSourceFake = (
  initial: Readonly<
    Record<
      string,
      ReadonlyArray<{
        readonly path: string;
        readonly sha: string;
        readonly files: ReadonlyArray<SkillFile>;
      }>
    >
  > = {},
) => {
  const repos = new Map(Object.entries(initial).map(([k, v]) => [k, [...v]] as const));
  const folder = (source: string, path: string) => repos.get(source)?.find((f) => f.path === path);
  const service: typeof SkillSource.Service = {
    list: (source) => {
      const found = repos.get(source);
      return found
        ? Effect.succeed(
            found.map((f) => {
              const slug = f.path.split("/").pop()!;
              const meta = parseSkillFrontmatter(
                f.files.find((x) => x.path === "SKILL.md")?.contents ?? "",
              );
              return {
                source,
                slug,
                name: meta.name || slug,
                description: meta.description,
                path: f.path,
              };
            }),
          )
        : Effect.fail(new SkillFetchFailed({ message: `${source} was not found` }));
    },
    latestSha: (source, path) => Effect.succeed(folder(source, path)?.sha ?? null),
    fetch: (source, path) => {
      const f = folder(source, path);
      return f
        ? Effect.succeed({ sha: f.sha, files: f.files })
        : Effect.fail(new SkillFetchFailed({ message: `${source}/${path} was not found` }));
    },
  };
  return {
    layer: Layer.succeed(SkillSource, service),
    /** The port itself, for a harness that takes the service rather than a layer. */
    service,
    /** Replaces (or adds) a folder upstream, as a new commit would. */
    publish: (
      source: string,
      next: {
        readonly path: string;
        readonly sha: string;
        readonly files: ReadonlyArray<SkillFile>;
      },
    ) => {
      const list = (repos.get(source) ?? []).filter((f) => f.path !== next.path);
      repos.set(source, [...list, next]);
    },
    /** Deletes a folder upstream. */
    remove: (source: string, path: string) => {
      repos.set(
        source,
        (repos.get(source) ?? []).filter((f) => f.path !== path),
      );
    },
  };
};

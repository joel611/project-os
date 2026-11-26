import {
  AgentRuntime,
  AgentRuntimeError,
  AuditLogRepository,
  ChannelMessageRepository,
  claimTicketUseCase,
  DEFAULT_CHANNEL_DIGEST,
  digestChannels,
  handleInbound,
  healthSweep,
  heartbeat,
  issueWorkerRegistration,
  ProjectRepository,
  ProjectSourceRepository,
  pruneAudit,
  readAudit,
  readProjectAudit,
  readWorkerAudit,
  redeemWorkerRegistration,
  stripMentions,
  unregisterSharedWorker,
  unregisterWorker,
  changeTicketStatus,
  type Person,
  type Project,
} from "@project-os/core";
import type { AuditEntry, InboundMessage } from "@project-os/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { classifierReturning, fixedClock, makeTestLayer } from "./index.ts";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const AT = NOW.toISOString();
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const ADA: Person = { channelType: "discord", id: "u1", name: "Ada" };

const project: Project = {
  id: "p1",
  orgId: "o1",
  name: "Acme",
  slug: null,
  customInstructions: "Web shop",
  defaultResponseChannelId: null,
  channelDigest: true,
  channelDigestNotify: false,
  status: "active",
  createdBy: null,
  createdAt: AT,
  updatedAt: AT,
};

const inbound = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channelType: "discord",
  externalId: "m1",
  channelId: "chan-1",
  sender: { id: "u1", name: "Ada" },
  content: "hello team",
  mentionsBot: false,
  raw: {},
  receivedAt: AT,
  ...over,
});

const THRESHOLDS = {
  workerStaleMs: 15 * 60_000,
  unpickedMs: 1e9,
  followUpMs: 1e9,
  inactivityFailMs: 1e9,
};

const run = <A, E>(
  effect: Effect.Effect<A, E, any>,
  options: { classifier?: string; pool?: boolean; failDigest?: string } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(project);
      yield* (yield* ProjectSourceRepository).insert({
        id: "s1",
        projectId: "p1",
        type: "discord_channel",
        externalId: "chan-1",
        name: "#general",
        alias: "chat",
        description: null,
        direction: "both",
        isDefaultResponse: true,
        config: {},
        status: "active",
        connectedBy: null,
        createdAt: AT,
        updatedAt: AT,
      });
      return yield* effect;
    }).pipe(
      Effect.provide(
        makeTestLayer({
          now: NOW,
          classifier: classifierReturning(options.classifier ?? "status_question"),
          ...(options.pool ? { sandboxPool: [{ workerType: "daytona_pi" as const }] } : {}),
          ...(options.failDigest === undefined ? {} : { failDigest: options.failDigest }),
        }).layer,
      ),
    ) as Effect.Effect<A, E, never>,
  );

const all = Effect.map(readAudit({}), (page) => page.entries);
const brief = (entries: ReadonlyArray<AuditEntry>) =>
  entries.map((e) => `${e.kind}/${e.action}${e.projectId ? `@${e.projectId}` : ""}`);

describe("stripMentions", () => {
  it("removes user, role, channel and everyone mentions", () => {
    expect(stripMentions("<@1> hi <@!2> <@&3> see <#4> @everyone @here ok")).toBe("hi see ok");
  });
});

describe("inbound events", () => {
  it("logs a classified message whose handling then failed, with the error", async () => {
    const failing = Layer.succeed(AgentRuntime, {
      respond: () => Effect.fail(new AgentRuntimeError({ message: "model down" })),
    });
    const out = await run(
      Effect.gen(function* () {
        yield* handleInbound(inbound({ mentionsBot: true }), {}).pipe(
          Effect.provide(failing),
          Effect.ignore,
        );
        return yield* all;
      }),
    );
    expect(brief(out)).toEqual(["inbound_event/classified@p1", "inbound_event/received@p1"]);
    expect(out[0]).toMatchObject({
      summary: "status_question 100% → failed",
      payload: {
        intent: { choice: "status_question", confidence: 1, probabilities: { status_question: 1 } },
        outcome: "error",
        error: "model down",
      },
    });
  });

  it("logs every message once, in its project or org-wide, without mentions", async () => {
    const out = await run(
      Effect.gen(function* () {
        const config = { requireMention: true, adminChannelId: "admin", adminUserIds: [] };
        yield* handleInbound(inbound({ content: "<@42> fyi" }), config);
        yield* handleInbound(inbound(), config);
        yield* handleInbound(
          inbound({
            externalId: "m2",
            channelId: "elsewhere",
            content: "",
            attachments: [
              { id: "a", filename: "x.png", contentType: null, size: 1, url: "https://x" },
            ],
          }),
          config,
        );
        yield* handleInbound(
          inbound({ externalId: "m3", channelId: "admin", content: "x".repeat(200) }),
          config,
        );
        return { org: yield* all, project: (yield* readProjectAudit("p1", {})).entries };
      }),
    );
    expect(brief(out.org)).toEqual([
      "inbound_event/received",
      "inbound_event/received",
      "inbound_event/received@p1",
    ]);
    expect(out.project).toHaveLength(1);
    const [linked] = out.project;
    expect(linked).toMatchObject({
      actorType: "person",
      actorId: "u1",
      actorName: "Ada",
      summary: "fyi",
      payload: { channelId: "chan-1", externalId: "m1", content: "fyi", mentionsBot: false },
    });
    const admin = out.org.find((e) => (e.payload as any).externalId === "m3")!;
    expect(admin.payload).toMatchObject({ admin: true });
    expect(admin.summary).toHaveLength(140);
    const unlinked = out.org.find((e) => (e.payload as any).externalId === "m2")!;
    expect(unlinked.summary).toBe("1 attachment(s)");
  });
});

describe("ticket events", () => {
  it("logs a ticket's creation, assignment, claim and status changes", async () => {
    const out = await run(
      Effect.gen(function* () {
        const outcome = yield* handleInbound(
          inbound({ mentionsBot: true, content: "build it" }),
          {},
        );
        const ticketId = (outcome as any).ticket.id as string;
        const workerId = (outcome as any).ticket.workerId as string;
        yield* claimTicketUseCase({ ticketId, workerId });
        yield* changeTicketStatus({
          ticketId,
          status: "completed",
          by: { type: "worker", id: workerId },
        });
        return (yield* readAudit({ kind: "ticket" })).entries;
      }),
      { classifier: "new_request", pool: true },
    );
    expect(out.map((e) => [e.action, e.actorType, e.summary]).reverse()).toEqual([
      ["created", "person", "Ticket created"],
      ["assigned", "coordinator", expect.stringMatching(/^Assigned to daytona-/)],
      ["claimed", "worker", expect.stringMatching(/^Claimed by daytona-/)],
      ["status_changed", "worker", "Status changed to completed"],
    ]);
    expect(out[0]!.payload).toMatchObject({ from: "in_progress", status: "completed" });
    expect(out.every((e) => e.projectId === "p1" && e.ticketId !== null)).toBe(true);
  });

  it("logs the actor given for a status change, even on a ticket with no worker", async () => {
    const out = await run(
      Effect.gen(function* () {
        const outcome = yield* handleInbound(inbound({ mentionsBot: true }), {});
        const ticketId = (outcome as any).ticket.id as string;
        yield* changeTicketStatus({
          ticketId,
          status: "cancelled",
          error: "nope",
          by: { type: "person", id: "u-op", name: "Op" },
        });
        return (yield* readAudit({ kind: "ticket" })).entries[0]!;
      }),
      { classifier: "new_request" },
    );
    expect(out).toMatchObject({
      actorType: "person",
      actorId: "u-op",
      actorName: "Op",
      payload: { error: "nope" },
    });
  });
});

describe("worker events", () => {
  it("logs registration, first heartbeat, outage, return and removal", async () => {
    const out = await run(
      Effect.gen(function* () {
        const { token } = yield* issueWorkerRegistration(ADA);
        const { worker } = yield* redeemWorkerRegistration({ token, name: "ada-mbp" });
        const beat = (at: Date) =>
          heartbeat({ workerId: worker.id, workerType: "local" }).pipe(
            Effect.provide(fixedClock(at)),
          );
        const sweep = (at: Date) => healthSweep(THRESHOLDS).pipe(Effect.provide(fixedClock(at)));
        yield* beat(NOW);
        yield* beat(minutes(5));
        yield* sweep(minutes(10));
        yield* sweep(minutes(30));
        yield* sweep(minutes(31));
        yield* beat(minutes(40));
        yield* unregisterWorker(ADA, "ada-mbp");
        return (yield* readAudit({ kind: "worker" })).entries;
      }),
    );
    expect(out.map((e) => [e.action, e.actorType, e.summary]).reverse()).toEqual([
      ["registered", "person", "ada-mbp registered"],
      ["first_seen", "worker", "ada-mbp came online for the first time"],
      ["went_offline", "coordinator", "ada-mbp went offline"],
      ["back_online", "worker", "ada-mbp is back online"],
      ["removed", "person", "ada-mbp removed"],
    ]);
    expect(out.every((e) => e.projectId === null && e.workerId !== null)).toBe(true);
  });

  it("logs a sandbox's first heartbeat and an admin removing a shared device", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* heartbeat({ workerId: "daytona-1", workerType: "daytona_pi" });
        const { token } = yield* issueWorkerRegistration(
          { channelType: "discord", id: "admin" },
          { shared: true },
        );
        yield* redeemWorkerRegistration({ token });
        yield* unregisterSharedWorker("my computer", ADA);
        const again = yield* redeemWorkerRegistration({
          token: (yield* issueWorkerRegistration(ADA, { shared: true })).token,
          name: "pool-2",
        });
        yield* unregisterSharedWorker(again.worker.id);
        return (yield* readAudit({ kind: "worker" })).entries;
      }),
    );
    expect(out.map((e) => [e.action, e.actorId]).reverse()).toEqual([
      ["first_seen", "daytona-1"],
      ["registered", "admin"],
      ["removed", "u1"],
      ["registered", "u1"],
      ["removed", null],
    ]);
    expect(out[1]!.payload).toMatchObject({ shared: true });
  });
});

describe("digest events", () => {
  const digestOnce = Effect.gen(function* () {
    yield* (yield* ChannelMessageRepository).append({
      id: "c-m1",
      projectId: "p1",
      channelType: "discord",
      channelId: "chan-1",
      threadId: null,
      externalId: "m1",
      senderId: "u1",
      senderName: "Ada",
      content: "we decided to use SQLite",
      url: null,
      sentAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    });
    yield* digestChannels(DEFAULT_CHANNEL_DIGEST);
    return (yield* readAudit({ kind: "digest_event" })).entries;
  });

  it("logs a run with the memory titles it saved", async () => {
    const out = await run(digestOnce);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      action: "digested",
      projectId: "p1",
      actorType: "coordinator",
      summary: "Read 1 message(s), saved 1 to Project Memory",
      payload: { messages: 1, saved: ["we decided to use SQLite"] },
    });
  });

  it("logs a failed run", async () => {
    const out = await run(digestOnce, { failDigest: "provider down" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      action: "failed",
      summary: "Digest failed: provider down",
      payload: { messages: 0, saved: [], error: "provider down" },
    });
  });
});

describe("a worker's feed", () => {
  it("returns only that worker's entries, and fails for an unknown worker", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* heartbeat({ workerId: "daytona-1", workerType: "daytona_pi" });
        yield* heartbeat({ workerId: "daytona-2", workerType: "daytona_pi" });
        const page = yield* readWorkerAudit("daytona-1", {});
        const missing = yield* Effect.flip(readWorkerAudit("nope", {}));
        return { page, missing };
      }),
    );
    expect(out.page.entries.map((e) => [e.workerId, e.action])).toEqual([
      ["daytona-1", "first_seen"],
    ]);
    expect(out.page.nextCursor).toBeNull();
    expect(out.missing._tag).toBe("WorkerNotFound");
  });
});

describe("reading and pruning", () => {
  const entry = (id: string, at: string, projectId: string | null = null): AuditEntry => ({
    id,
    at,
    kind: "worker",
    action: "registered",
    actorType: "coordinator",
    actorId: null,
    actorName: null,
    projectId,
    ticketId: null,
    workerId: null,
    summary: id,
    payload: null,
  });

  it("pages newest-logged first by cursor, filters by kind, and drops entries past retention", async () => {
    const out = await run(
      Effect.gen(function* () {
        const repo = yield* AuditLogRepository;
        yield* repo.append(entry("a", "2026-11-13T00:00:00.000Z"));
        yield* repo.append(entry("b", "2026-11-13T00:00:00.000Z", "p1"));
        yield* repo.append(entry("c", "2026-11-13T01:00:00.000Z"));
        yield* repo.append(entry("old", "2026-01-01T00:00:00.000Z"));
        const first = yield* readAudit({ limit: 2 });
        const second = yield* readAudit({ limit: 2, before: first.nextCursor! });
        const bogus = yield* readAudit({ before: "no-cursor", limit: 500 });
        const tickets = yield* readAudit({ kind: "ticket" });
        const pruned = yield* pruneAudit(30 * 24 * 60 * 60_000);
        const missing = yield* Effect.flip(readProjectAudit("nope", {}));
        return { first, second, bogus, tickets, pruned, left: yield* all, missing };
      }),
    );
    expect(out.first.entries.map((e) => e.id)).toEqual(["old", "c"]);
    expect(out.first.nextCursor).toBe("3");
    expect(out.second.entries.map((e) => e.id)).toEqual(["b", "a"]);
    expect(out.bogus.entries).toHaveLength(4);
    expect(out.bogus.nextCursor).toBeNull();
    expect(out.tickets.entries).toEqual([]);
    expect(out.pruned).toBe(1);
    expect(out.left.map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(out.missing._tag).toBe("ProjectNotFound");
  });
});

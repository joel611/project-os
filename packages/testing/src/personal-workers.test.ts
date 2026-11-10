import {
  authenticateCaller,
  authenticateWorker,
  guardActingAs,
  guardTicketAccess,
  handleInbound,
  heartbeat,
  issueSandboxToken,
  issueWorkerRegistration,
  KeyValueStore,
  listPersonalWorkers,
  onlinePersonalWorker,
  ProjectRepository,
  ProjectSourceRepository,
  redeemWorkerRegistration,
  sha256Hex,
  TicketRepository,
  unregisterWorker,
  workerLabel,
  WorkerRepository,
  type Person,
} from "@project-os/core";
import type { InboundMessage } from "@project-os/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { classifierReturning, makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const ADA: Person = { channelType: "discord", id: "u1", name: "Ada" };
const BOB: Person = { channelType: "discord", id: "u2", name: "Bob" };

const run = <A, E>(
  eff: Effect.Effect<A, E, any>,
  classifier = classifierReturning("new_request"),
) => {
  const t = makeTestLayer({ classifier, sandboxPool: [{ workerType: "daytona_pi" }] });
  return Effect.runPromise(eff.pipe(Effect.provide(t.layer)) as Effect.Effect<A, E>).then(
    (value) => ({ value, launched: t.launched }),
  );
};

/** Registers a device for `person`; `online` heartbeats it at the (fixed) current time. */
const device = (person: Person, online: boolean, name?: string) =>
  Effect.gen(function* () {
    const { token } = yield* issueWorkerRegistration(person);
    const out = yield* redeemWorkerRegistration({ token, ...(name ? { name } : {}) });
    if (online) {
      yield* heartbeat({ workerId: out.worker.id, workerType: out.worker.workerType });
    }
    return out;
  });

describe("worker registration", () => {
  it("binds the device to whoever ran /register-worker and authenticates by its secret", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const { token, expiresInSeconds } = yield* issueWorkerRegistration(ADA);
        const { worker, secret } = yield* redeemWorkerRegistration({ token, hostname: "ada-mbp" });
        return {
          token,
          expiresInSeconds,
          worker,
          secret,
          authed: yield* authenticateWorker(secret),
          wrong: yield* authenticateWorker("not-the-secret"),
        };
      }),
    );
    expect(value.token).toMatch(/^[\w-]{32}$/);
    expect(value.expiresInSeconds).toBe(600);
    expect(value.worker).toMatchObject({
      workerType: "local",
      ownerChannelType: "discord",
      ownerId: "u1",
      name: "ada-mbp",
    });
    expect(value.worker.id).toMatch(/^local-/);
    expect(value.secret).not.toBe(value.token);
    expect(value.authed?.id).toBe(value.worker.id);
    expect(value.wrong).toBeUndefined();
  });

  it("works once, and refuses unknown codes", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const { token } = yield* issueWorkerRegistration(ADA);
        yield* redeemWorkerRegistration({ token });
        return {
          again: yield* Effect.flip(redeemWorkerRegistration({ token })),
          unknown: yield* Effect.flip(redeemWorkerRegistration({ token: "nope" })),
        };
      }),
    );
    expect(value.again._tag).toBe("RegistrationInvalid");
    expect(value.unknown._tag).toBe("RegistrationInvalid");
  });

  it("refuses a code a racing Watcher already took", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const { token } = yield* issueWorkerRegistration(ADA);
        const hash = yield* sha256Hex(token);
        yield* (yield* KeyValueStore).set(`worker-register-used:${hash}`, "1");
        return yield* Effect.flip(redeemWorkerRegistration({ token }));
      }),
    );
    expect(value._tag).toBe("RegistrationInvalid");
  });

  it("names a worker by its name, else its id", () => {
    const base = { id: "local-1", workerType: "local" as const, ownerChannelType: null };
    const w = {
      ...base,
      ownerId: null,
      registered: true,
      currentTicketId: null,
      lastSeenAt: T0,
      createdAt: T0,
    };
    expect(workerLabel({ ...w, name: "mbp" })).toBe("mbp");
    expect(workerLabel({ ...w, name: null })).toBe("local-1");
  });

  it("stores only the code's hash, with a TTL", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const { token } = yield* issueWorkerRegistration(ADA);
        return yield* (yield* KeyValueStore).get(`worker-register:${token}`);
      }),
    );
    expect(value).toBeUndefined();
  });

  it("lists and removes only the person's own devices", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* device(ADA, true, "laptop");
        yield* device(ADA, false, "desktop");
        const bobs = yield* device(BOB, true, "bob-box");
        const listed = yield* listPersonalWorkers(ADA, 15 * 60_000);
        return {
          listed: listed.map((w) => [w.worker.name, w.status]),
          notMine: yield* unregisterWorker(ADA, bobs.worker.id),
          removed: (yield* unregisterWorker(ADA, "LAPTOP"))?.name,
          after: (yield* listPersonalWorkers(ADA, 15 * 60_000)).map((w) => w.worker.name),
        };
      }),
    );
    expect(value.listed).toEqual([
      ["laptop", "online"],
      ["desktop", "offline"],
    ]);
    expect(value.notMine).toBeUndefined();
    expect(value.removed).toBe("laptop");
    expect(value.after).toEqual(["desktop"]);
  });
});

const msg = (sender: Person, externalId = "m1"): InboundMessage => ({
  channelType: "discord",
  externalId,
  channelId: "chan-1",
  sender: { id: sender.id, ...(sender.name ? { name: sender.name } : {}) },
  content: "please fix login",
  mentionsBot: true,
  raw: {},
  receivedAt: T0,
});

const linkChannel = Effect.gen(function* () {
  yield* (yield* ProjectRepository).insert({
    id: "p1",
    orgId: "o1",
    name: "Acme",
    slug: null,
    customInstructions: "",
    defaultResponseChannelId: null,
    status: "active",
    createdBy: null,
    createdAt: T0,
    updatedAt: T0,
  });
  yield* (yield* ProjectSourceRepository).insert({
    id: "s1",
    projectId: "p1",
    type: "discord_channel",
    externalId: "chan-1",
    name: "#general",
    alias: "general",
    description: null,
    direction: "both",
    isDefaultResponse: true,
    config: {},
    status: "active",
    connectedBy: null,
    createdAt: T0,
    updatedAt: T0,
  });
});

const newTicket = (sender: Person, externalId?: string) =>
  Effect.gen(function* () {
    const out = yield* handleInbound(msg(sender, externalId), {});
    if (out.kind !== "ticket_created") throw new Error(out.kind);
    return out.ticket;
  });

describe("ticket routing", () => {
  it("gives a new ticket to the requester's online device, and launches nothing", async () => {
    const { value, launched } = await run(
      Effect.gen(function* () {
        yield* linkChannel;
        const { worker } = yield* device(ADA, true);
        const ticket = yield* newTicket(ADA);
        const events = yield* (yield* TicketRepository).listEvents(ticket.id);
        return { worker, ticket, assigned: events.find((e) => e.type === "assigned") };
      }),
    );
    expect(value.ticket).toMatchObject({ workerId: value.worker.id, workerType: "local" });
    expect(value.assigned?.body).toBe(
      `Assigned to the requester's own worker ${value.worker.name}`,
    );
    expect(launched).toEqual([]);
  });

  it("sends tickets to the sandbox pool when the device is offline or someone else asks", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* linkChannel;
        yield* device(ADA, false);
        yield* device(BOB, true);
        return yield* newTicket(ADA);
      }),
    );
    expect(value).toMatchObject({
      workerType: "daytona_pi",
      workerId: `daytona-${value.id}`,
    });
  });

  it("prefers the most recently seen online device", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const a = yield* device(ADA, true, "a");
        const b = yield* device(ADA, true, "b");
        yield* (yield* WorkerRepository).heartbeat({
          workerId: a.worker.id,
          workerType: "local",
          ticketId: null,
          at: "2026-11-03T23:59:00.000Z",
        });
        return { picked: yield* onlinePersonalWorker(ADA, 15 * 60_000), b: b.worker.id };
      }),
    );
    expect(value.picked?.id).toBe(value.b);
  });
});

describe("MCP credentials", () => {
  it("knows a device by its secret and a sandbox session by its launch token", async () => {
    const t = makeTestLayer({
      classifier: classifierReturning("new_request"),
      sandboxPool: [{ workerType: "daytona_pi" }],
    });
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        yield* linkChannel;
        const ada = yield* device(ADA, true);
        const sandboxTicket = yield* newTicket(BOB);
        const [launch] = t.launched;
        return {
          ada: ada.worker.id,
          sandboxWorker: sandboxTicket.workerId,
          byDevice: yield* authenticateCaller(ada.secret),
          bySandbox: yield* authenticateCaller(launch!.mcpToken),
          unknown: yield* authenticateCaller("not-a-token"),
        };
      }).pipe(Effect.provide(t.layer)) as Effect.Effect<any>,
    );
    expect(value.byDevice).toEqual({ id: value.ada });
    expect(value.bySandbox).toEqual({ id: value.sandboxWorker });
    expect(value.sandboxWorker).toMatch(/^daytona-/);
    expect(value.unknown).toBeUndefined();
  });

  it("forgets a sandbox token once it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { value } = await run(
        Effect.gen(function* () {
          const token = yield* issueSandboxToken("daytona-t1", 60);
          const live = yield* authenticateCaller(token);
          vi.setSystemTime(Date.now() + 61_000);
          return { live, expired: yield* authenticateCaller(token) };
        }),
      );
      expect(value).toEqual({ live: { id: "daytona-t1" }, expired: undefined });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MCP guards", () => {
  it("keeps every worker to its own id and the tickets assigned to it", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* linkChannel;
        const ada = { id: (yield* device(ADA, true)).worker.id };
        const bob = { id: (yield* device(BOB, true)).worker.id };
        const adaTicket = yield* newTicket(ADA, "m1");
        const sandboxTicket = yield* newTicket(
          { channelType: "discord", id: "u9", name: "Cy" },
          "m2",
        );
        const sandbox = { id: sandboxTicket.workerId! };
        yield* (yield* TicketRepository).insert({
          ...sandboxTicket,
          id: "t-queued",
          status: "open",
          workerType: null,
          workerId: null,
        });
        const ok = (e: Effect.Effect<void, any, any>) =>
          e.pipe(
            Effect.as("ok"),
            Effect.catch((err: { _tag: string }) => Effect.succeed(err._tag)),
          );
        return {
          adaSelf: yield* ok(guardActingAs(ada.id, ada)),
          adaAsBob: yield* ok(guardActingAs(bob.id, ada)),
          sandboxSelf: yield* ok(guardActingAs(sandbox.id, sandbox)),
          sandboxAsAda: yield* ok(guardActingAs(ada.id, sandbox)),
          adaOnHers: yield* ok(guardTicketAccess(adaTicket.id, ada)),
          bobOnAdas: yield* ok(guardTicketAccess(adaTicket.id, bob)),
          sandboxOnAdas: yield* ok(guardTicketAccess(adaTicket.id, sandbox)),
          sandboxOnItsOwn: yield* ok(guardTicketAccess(sandboxTicket.id, sandbox)),
          adaOnSandboxes: yield* ok(guardTicketAccess(sandboxTicket.id, ada)),
          queued: yield* ok(guardTicketAccess("t-queued", ada)),
          missingTicket: yield* ok(guardTicketAccess("nope", ada)),
        };
      }),
    );
    expect(value).toEqual({
      adaSelf: "ok",
      adaAsBob: "WorkerUnauthorized",
      sandboxSelf: "ok",
      sandboxAsAda: "WorkerUnauthorized",
      adaOnHers: "ok",
      bobOnAdas: "WorkerUnauthorized",
      sandboxOnAdas: "WorkerUnauthorized",
      sandboxOnItsOwn: "ok",
      adaOnSandboxes: "WorkerUnauthorized",
      queued: "WorkerUnauthorized",
      missingTicket: "ok",
    });
  });

  it("authenticates a shared device by its secret and keeps it to its own tickets", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* linkChannel;
        const { token } = yield* issueWorkerRegistration(ADA, { shared: true });
        const shared = yield* redeemWorkerRegistration({ token, hostname: "build-box" });
        yield* heartbeat({ workerId: shared.worker.id, workerType: "local" });
        const ticket = yield* newTicket(BOB);
        const caller = (yield* authenticateCaller(shared.secret))!;
        const ok = (e: Effect.Effect<void, any, any>) =>
          e.pipe(
            Effect.as("ok"),
            Effect.catch((err: { _tag: string }) => Effect.succeed(err._tag)),
          );
        return {
          worker: shared.worker,
          ticket,
          caller,
          self: yield* ok(guardActingAs(shared.worker.id, caller)),
          ticketSelf: yield* ok(guardTicketAccess(ticket.id, caller)),
        };
      }),
    );
    expect(value.worker).toMatchObject({ ownerId: null, ownerChannelType: null, registered: true });
    expect(value.worker.id).toMatch(/^shared-/);
    // Bob has no device of his own: the shared device takes his ticket before the sandbox pool.
    expect(value.ticket.workerId).toBe(value.worker.id);
    expect(value.caller).toEqual({ id: value.worker.id });
    expect(value).toMatchObject({ self: "ok", ticketSelf: "ok" });
  });
});

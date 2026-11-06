import {
  authenticateWorker,
  guardActingAs,
  guardTicketAccess,
  handleInbound,
  heartbeat,
  issueWorkerRegistration,
  KeyValueStore,
  listPersonalWorkers,
  onlinePersonalWorker,
  ProjectRepository,
  ProjectSourceRepository,
  redeemWorkerRegistration,
  TicketRepository,
  unregisterWorker,
  WorkerRepository,
  type Person,
} from "@project-os/core";
import type { InboundMessage } from "@project-os/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { classifierReturning, makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const ADA: Person = { channelType: "discord", id: "u1", name: "Ada" };
const BOB: Person = { channelType: "discord", id: "u2", name: "Bob" };

const run = <A, E>(
  eff: Effect.Effect<A, E, any>,
  classifier = classifierReturning("new_request"),
) => {
  const t = makeTestLayer({ classifier });
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
      workerType: "local_claude",
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
  sender: { id: sender.id, name: sender.name! },
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
    const out = yield* handleInbound(msg(sender, externalId), {
      workerId: "shared-1",
      defaultWorkerType: "daytona_pi",
    });
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
    expect(value.ticket).toMatchObject({ workerId: value.worker.id, workerType: "local_claude" });
    expect(value.assigned?.body).toContain("Ada's worker");
    expect(launched).toEqual([
      { ticketId: value.ticket.id, workerType: "local_claude", workerId: value.worker.id },
    ]);
  });

  it("sends tickets to the shared cloud worker when the device is offline or someone else asks", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* linkChannel;
        yield* device(ADA, false);
        yield* device(BOB, true);
        return yield* newTicket(ADA);
      }),
    );
    expect(value).toMatchObject({ workerType: "daytona_pi", workerId: `daytona-${value.id}` });
  });

  it("prefers the most recently seen online device", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const a = yield* device(ADA, true, "a");
        const b = yield* device(ADA, true, "b");
        yield* (yield* WorkerRepository).heartbeat({
          workerId: a.worker.id,
          workerType: "local_claude",
          ticketId: null,
          at: "2026-11-03T23:59:00.000Z",
        });
        return { picked: yield* onlinePersonalWorker(ADA, 15 * 60_000), b: b.worker.id };
      }),
    );
    expect(value.picked?.id).toBe(value.b);
  });
});

describe("MCP guards", () => {
  it("lets shared workers act without credentials, and personal ones only with their own", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* linkChannel;
        const ada = yield* device(ADA, true);
        const bob = yield* device(BOB, true);
        const adaTicket = yield* newTicket(ADA, "m1");
        const sharedTicket = yield* newTicket(
          { channelType: "discord", id: "u9", name: "Cy" },
          "m2",
        );
        const ok = (e: Effect.Effect<void, any, any>) =>
          e.pipe(
            Effect.as("ok"),
            Effect.catch((err: { _tag: string }) => Effect.succeed(err._tag)),
          );
        return {
          sharedAnon: yield* ok(guardActingAs("shared-1", undefined)),
          personalAnon: yield* ok(guardActingAs(ada.worker.id, undefined)),
          personalSelf: yield* ok(guardActingAs(ada.worker.id, ada.worker)),
          personalOther: yield* ok(guardActingAs(ada.worker.id, bob.worker)),
          ticketAnon: yield* ok(guardTicketAccess(adaTicket.id, undefined)),
          ticketOwner: yield* ok(guardTicketAccess(adaTicket.id, ada.worker)),
          ticketOther: yield* ok(guardTicketAccess(adaTicket.id, bob.worker)),
          sharedTicketAnon: yield* ok(guardTicketAccess(sharedTicket.id, undefined)),
          sharedTicketPersonal: yield* ok(guardTicketAccess(sharedTicket.id, ada.worker)),
        };
      }),
    );
    expect(value).toEqual({
      sharedAnon: "ok",
      personalAnon: "WorkerUnauthorized",
      personalSelf: "ok",
      personalOther: "WorkerUnauthorized",
      ticketAnon: "WorkerUnauthorized",
      ticketOwner: "ok",
      ticketOther: "WorkerUnauthorized",
      sharedTicketAnon: "ok",
      sharedTicketPersonal: "WorkerUnauthorized",
    });
  });
});

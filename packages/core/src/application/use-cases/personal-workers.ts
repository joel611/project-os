import type { WorkerType } from "@project-os/contracts";
import { Effect, Option, Schema } from "effect";
import {
  isPersonal,
  RegistrationInvalid,
  type Worker,
  WorkerUnauthorized,
  workerStatus,
} from "../../domain/index.ts";
import {
  Clock,
  IdGenerator,
  KeyValueStore,
  type Person,
  TicketRepository,
  WorkerRepository,
} from "../ports/index.ts";
import { nowIso } from "./tickets.ts";

/** How long a /register-worker code works, once. */
export const REGISTRATION_TTL_SECONDS = 10 * 60;

const PendingRegistration = Schema.fromJsonString(
  Schema.Struct({
    channelType: Schema.Literals(["discord", "email", "chat"]),
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
  }),
);
const decodePending = Schema.decodeUnknownOption(PendingRegistration);

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A random URL-safe secret. Web Crypto: works on Bun and Workers alike. */
export const randomSecret = (bytes = 32): Effect.Effect<string> =>
  Effect.sync(() => base64url(crypto.getRandomValues(new Uint8Array(bytes))));

/** Hex SHA-256: what the Coordinator stores in place of codes and device secrets. */
export const sha256Hex = (value: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  });

const pendingKey = (hash: string) => `worker-register:${hash}`;
const usedKey = (hash: string) => `worker-register-used:${hash}`;

/**
 * Starts registering a device for `person`: a one-time code, valid for
 * `REGISTRATION_TTL_SECONDS`, that the Watcher trades for its credentials. Only the code's
 * hash is stored.
 */
export const issueWorkerRegistration = (person: Person) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    const token = yield* randomSecret(24);
    const hash = yield* sha256Hex(token);
    yield* kv.set(
      pendingKey(hash),
      JSON.stringify({
        channelType: person.channelType,
        id: person.id,
        ...(person.name ? { name: person.name } : {}),
      }),
      { ttlSeconds: REGISTRATION_TTL_SECONDS },
    );
    return { token, expiresInSeconds: REGISTRATION_TTL_SECONDS };
  });

const WORKER_NAME_MAX = 60;

/**
 * Trades a /register-worker code for a personal worker bound to whoever ran the command.
 * The code works once. Returns the worker and its bearer secret (shown only here).
 */
export const redeemWorkerRegistration = (input: {
  readonly token: string;
  readonly name?: string;
  readonly hostname?: string;
  readonly workerType?: WorkerType;
}) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    const workers = yield* WorkerRepository;
    const ids = yield* IdGenerator;

    const invalid = new RegistrationInvalid({
      message:
        "This registration code is unknown, expired, or already used. Run /register-worker again.",
    });
    const hash = yield* sha256Hex(input.token);
    const owner = decodePending(yield* kv.get(pendingKey(hash)));
    if (Option.isNone(owner)) return yield* invalid;
    // Two Watchers racing with one code: only the first gets a device.
    const first = yield* kv.setIfAbsent(usedKey(hash), "1", {
      ttlSeconds: REGISTRATION_TTL_SECONDS,
    });
    if (!first) return yield* invalid;
    yield* kv.delete(pendingKey(hash));

    const secret = yield* randomSecret(32);
    const name = (input.name?.trim() || input.hostname?.trim() || "my computer").slice(
      0,
      WORKER_NAME_MAX,
    );
    const worker = yield* workers.register({
      id: `local-${yield* ids.next}`,
      workerType: input.workerType ?? "local_claude",
      owner: { channelType: owner.value.channelType, id: owner.value.id },
      name,
      secretHash: yield* sha256Hex(secret),
      at: yield* nowIso,
    });
    return { worker, secret };
  });

/** The personal worker a bearer secret belongs to, or undefined. */
export const authenticateWorker = (secret: string) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    return yield* workers.findBySecretHash(yield* sha256Hex(secret));
  });

/** This person's registered devices, with online/offline from their last heartbeat. */
export const listPersonalWorkers = (person: Person, staleAfterMs: number) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const mine = yield* workers.listByOwner(person.channelType, person.id);
    return mine.map((worker) => ({ worker, status: workerStatus(worker, now, staleAfterMs) }));
  });

/**
 * Removes one of this person's devices, matched by id or name. Someone else's device is
 * reported as not found. Returns the removed worker, or undefined.
 */
export const unregisterWorker = (person: Person, idOrName: string) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    const wanted = idOrName.trim().toLowerCase();
    const target = (yield* workers.listByOwner(person.channelType, person.id)).find(
      (w) => w.id.toLowerCase() === wanted || w.name?.toLowerCase() === wanted,
    );
    if (!target) return undefined;
    yield* workers.remove(target.id);
    return target;
  });

/**
 * The device that should take `person`'s next ticket: their most recently seen personal
 * worker that is online. Undefined sends the ticket to the shared worker instead.
 */
export const onlinePersonalWorker = (person: Person, staleAfterMs: number) =>
  Effect.gen(function* () {
    const online = (yield* listPersonalWorkers(person, staleAfterMs))
      .filter((w) => w.status === "online")
      .map((w) => w.worker)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return online[0];
  });

const unauthorized = (workerId: string, message: string) =>
  new WorkerUnauthorized({ workerId, message });

const findWorker = (id: string) =>
  Effect.flatMap(WorkerRepository, (w) => w.get(id)).pipe(
    Effect.map((w): Worker | undefined => w),
    Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
  );

/**
 * MCP guard for tools that act as `workerId` (list, claim, heartbeat). Shared workers need no
 * credentials, as before. A personal worker must be the caller, and a personal caller may only
 * act as itself.
 */
export const guardActingAs = (workerId: string, caller: Worker | undefined) =>
  Effect.gen(function* () {
    if (caller) {
      if (caller.id !== workerId) {
        return yield* unauthorized(workerId, "A personal worker can only act as itself.");
      }
      return;
    }
    const target = yield* findWorker(workerId);
    if (target && isPersonal(target)) {
      return yield* unauthorized(
        workerId,
        "This is a personal worker: send its secret as a Bearer token.",
      );
    }
  });

/**
 * MCP guard for tools on one ticket. A ticket assigned to a personal worker is reachable only
 * with that worker's secret (it may carry the owner's OAuth tokens), and a personal worker
 * only reaches its own tickets.
 */
export const guardTicketAccess = (ticketId: string, caller: Worker | undefined) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const ticket = yield* tickets.get(ticketId).pipe(Effect.option);
    // A missing ticket is the tool's own error to report.
    if (Option.isNone(ticket)) return;
    const assignee = ticket.value.workerId;
    if (caller) {
      if (assignee !== caller.id) {
        return yield* unauthorized(caller.id, "This ticket isn't assigned to this worker.");
      }
      return;
    }
    const target = assignee === null ? undefined : yield* findWorker(assignee);
    if (target && isPersonal(target)) {
      return yield* unauthorized(
        target.id,
        "This ticket belongs to a personal worker: send its secret as a Bearer token.",
      );
    }
  });

import type { WorkerType } from "@project-os/contracts";
import { Effect, Option, Schema } from "effect";
import {
  isSharedDevice,
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
import { authenticateSandbox } from "./sandbox-credentials.ts";
import { randomSecret, sha256Hex } from "./secrets.ts";
import { nowIso } from "./tickets.ts";
import { auditWorker, COORDINATOR } from "./audit.ts";

const personActor = (person: Person) => ({
  type: "person" as const,
  id: person.id,
  name: person.name ?? null,
});

/** How long a /register-worker code works, once. */
export const REGISTRATION_TTL_SECONDS = 10 * 60;

const PendingRegistration = Schema.fromJsonString(
  Schema.Struct({
    channelType: Schema.Literals(["discord", "email", "chat"]),
    id: Schema.String,
    /** Who ran /register-worker, for the audit log. */
    name: Schema.optionalKey(Schema.String),
    /** An admin's code: the device joins the pool as a shared worker instead of theirs. */
    shared: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodePending = Schema.decodeUnknownOption(PendingRegistration);

const pendingKey = (hash: string) => `worker-register:${hash}`;
const usedKey = (hash: string) => `worker-register-used:${hash}`;

/**
 * Starts registering a device: a one-time code, valid for `REGISTRATION_TTL_SECONDS`, that the
 * Watcher trades for its credentials. Only the code's hash is stored. By default the device
 * becomes `person`'s personal worker; with `shared` (admins only, checked by the caller) it
 * joins the pool as a shared worker that serves everyone.
 */
export const issueWorkerRegistration = (
  person: Person,
  options: { readonly shared?: boolean } = {},
) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    const token = yield* randomSecret(24);
    const hash = yield* sha256Hex(token);
    yield* kv.set(
      pendingKey(hash),
      JSON.stringify({
        channelType: person.channelType,
        id: person.id,
        ...(person.name !== undefined && { name: person.name }),
        ...(options.shared && { shared: true }),
      }),
      { ttlSeconds: REGISTRATION_TTL_SECONDS },
    );
    return { token, expiresInSeconds: REGISTRATION_TTL_SECONDS };
  });

const WORKER_NAME_MAX = 60;

/**
 * Trades a /register-worker code for a registered device: a personal worker bound to whoever
 * ran the command, or a shared worker (no owner) for an admin's shared code. The code works
 * once. Returns the worker and its bearer secret (shown only here).
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
    const pending = decodePending(yield* kv.get(pendingKey(hash)));
    if (Option.isNone(pending)) return yield* invalid;
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
    const shared = pending.value.shared === true;
    const worker = yield* workers.register({
      id: `${shared ? "shared" : "local"}-${yield* ids.next}`,
      workerType: input.workerType ?? "local",
      owner: shared ? null : { channelType: pending.value.channelType, id: pending.value.id },
      name,
      secretHash: yield* sha256Hex(secret),
      at: yield* nowIso,
    });
    yield* auditWorker(worker, "registered", {
      actor: { type: "person", id: pending.value.id, name: pending.value.name ?? null },
    });
    return { worker, secret };
  });

/** The registered worker (personal or shared) a bearer secret belongs to, or undefined. */
export const authenticateWorker = (secret: string) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    return yield* workers.findBySecretHash(yield* sha256Hex(secret));
  });

/** Who is calling MCP: the worker id its Bearer credentials belong to. */
export interface McpCaller {
  readonly id: string;
}

/** A registered device's secret or a sandbox session's token; undefined for anything else. */
export const authenticateCaller = (token: string) =>
  Effect.gen(function* () {
    const id = (yield* authenticateWorker(token))?.id ?? (yield* authenticateSandbox(token));
    return id === undefined ? undefined : ({ id } satisfies McpCaller);
  });

/** This person's registered devices, with online/offline from their last heartbeat. */
export const listPersonalWorkers = (person: Person, staleAfterMs: number) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const mine = yield* workers.listByOwner(person.channelType, person.id);
    return mine.map((worker) => ({ worker, status: workerStatus(worker, now, staleAfterMs) }));
  });

/** Matches a worker by id or name, ignoring case. */
const named = (idOrName: string) => {
  const wanted = idOrName.trim().toLowerCase();
  return (w: Worker) => w.id.toLowerCase() === wanted || w.name?.toLowerCase() === wanted;
};

/**
 * Removes one of this person's devices, matched by id or name. Someone else's device is
 * reported as not found. Returns the removed worker, or undefined.
 */
export const unregisterWorker = (person: Person, idOrName: string) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    const target = (yield* workers.listByOwner(person.channelType, person.id)).find(
      named(idOrName),
    );
    if (!target) return undefined;
    yield* workers.remove(target.id);
    yield* auditWorker(target, "removed", { actor: personActor(person) });
    return target;
  });

/** Shared devices admins registered into the pool, with online/offline. */
export const listSharedWorkers = (staleAfterMs: number) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    return (yield* workers.list)
      .filter(isSharedDevice)
      .map((worker) => ({ worker, status: workerStatus(worker, now, staleAfterMs) }));
  });

/** Removes a shared device, matched by id or name (admins only, checked by the caller). */
export const unregisterSharedWorker = (idOrName: string, admin?: Person) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    const target = (yield* workers.list).filter(isSharedDevice).find(named(idOrName));
    if (!target) return undefined;
    yield* workers.remove(target.id);
    yield* auditWorker(target, "removed", {
      actor: admin === undefined ? COORDINATOR : personActor(admin),
    });
    return target;
  });

const unauthorized = (workerId: string, message: string) =>
  new WorkerUnauthorized({ workerId, message });

/** MCP guard for tools that act as `workerId` (list, claim, heartbeat): only as itself. */
export const guardActingAs = (workerId: string, caller: McpCaller) =>
  caller.id === workerId
    ? Effect.void
    : Effect.fail(unauthorized(workerId, "A worker can only act as itself."));

/**
 * MCP guard for tools on one ticket: only its assignee reaches it (it may carry the requester's
 * OAuth tokens).
 */
export const guardTicketAccess = (ticketId: string, caller: McpCaller) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const ticket = yield* tickets.get(ticketId).pipe(Effect.option);
    // A missing ticket is the tool's own error to report.
    if (Option.isNone(ticket)) return;
    if (ticket.value.workerId !== caller.id) {
      return yield* unauthorized(caller.id, "This ticket isn't assigned to this worker.");
    }
  });

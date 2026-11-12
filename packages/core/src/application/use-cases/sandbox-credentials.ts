import { SANDBOX_PROVIDER_OF, type SandboxWorkerType } from "@project-os/contracts";
import { Effect } from "effect";
import { KeyValueStore, type SandboxPoolEntry } from "../ports/index.ts";
import { randomSecret, sha256Hex } from "./secrets.ts";

/**
 * The worker id a sandbox session claims as: one fresh worker per ticket, `<provider>-<id>`
 * with the provider name, e.g. `daytona-<id>`.
 */
export const sandboxWorkerId = (workerType: SandboxWorkerType, ticketId: string) =>
  `${SANDBOX_PROVIDER_OF[workerType]}-${ticketId}`;

/** How long a sandbox session runs when its provider doesn't say. */
export const DEFAULT_SANDBOX_SESSION_SECONDS = 30 * 60;

/** A sandbox's MCP token outlives its session by this much, for its last calls. */
const SANDBOX_TOKEN_MARGIN_SECONDS = 5 * 60;

/** How long the MCP token for a session on this provider works. */
export const sandboxTokenTtlSeconds = (entry: SandboxPoolEntry | undefined) =>
  (entry?.sessionTimeoutSeconds ?? DEFAULT_SANDBOX_SESSION_SECONDS) + SANDBOX_TOKEN_MARGIN_SECONDS;

const sandboxTokenKey = (hash: string) => `sandbox-token:${hash}`;

/**
 * Mints the Bearer token a sandbox session calls MCP with. It acts as `workerId` only and stops
 * working after `ttlSeconds`. Only its hash is stored.
 */
export const issueSandboxToken = (workerId: string, ttlSeconds: number) =>
  Effect.gen(function* () {
    const token = yield* randomSecret(32);
    const kv = yield* KeyValueStore;
    yield* kv.set(sandboxTokenKey(yield* sha256Hex(token)), workerId, { ttlSeconds });
    return token;
  });

/** Stops a token working before it expires, e.g. when its session never started. */
export const revokeSandboxToken = (token: string) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    yield* kv.delete(sandboxTokenKey(yield* sha256Hex(token)));
  });

/** The sandbox worker id a token was minted for, or undefined (unknown or expired). */
export const authenticateSandbox = (token: string) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    return yield* kv.get(sandboxTokenKey(yield* sha256Hex(token)));
  });

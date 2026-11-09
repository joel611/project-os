import type { ChannelType } from "@project-os/contracts";
import { ChannelGateway, KeyValueStore, Scheduler, WorkerLauncher } from "@project-os/core";
import { schema, SqliteRepositories } from "@project-os/db-sqlite";
import {
  AgentRuntimePending,
  DEFAULT_ORG,
  IdGeneratorUuid,
  makeHttpChannelGateway,
  noopLauncher,
  SidekickPending,
  SystemClockLive,
  UserConnectionsUnavailable,
} from "@project-os/infra-local/shared";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { makeWorkersKeyValueStore } from "./kv.ts";

export { DEFAULT_ORG, makeWorkersKeyValueStore };

/**
 * Creates the org if missing. Idempotent. Projects reference `orgs.id`, and nothing else
 * creates one. Returns the org id.
 */
export const ensureOrg = (
  db: D1Database,
  org: { readonly id: string; readonly name: string } = DEFAULT_ORG,
) =>
  Effect.promise(async () => {
    await drizzle(db)
      .insert(schema.orgs)
      .values({ ...org, createdAt: new Date().toISOString() })
      .onConflictDoNothing();
    return org.id;
  });

export interface CloudflareConfig {
  /** D1 binding. Alchemy applies the migrations on deploy, so this never migrates. */
  readonly db: D1Database;
  /** Workers KV binding. */
  readonly kv: KVNamespace;
  /** Base URL per Channel Adapter (its `/reply` endpoint host). */
  readonly adapterUrls: Partial<Record<ChannelType, string>>;
  /** Starts workers for assigned tickets. Default: none (a Watcher pulls the work). */
  readonly workerLauncher?: typeof WorkerLauncher.Service;
}

/**
 * A Worker has no process to keep a timer in, so `every` does nothing. Recurring work belongs
 * to a Cron Trigger calling a `scheduled` handler (not wired yet).
 */
const SchedulerNoop = Layer.succeed(Scheduler, {
  every: () => Effect.succeed(Effect.void),
});

/** Every core port for the Cloudflare target (D1 + KV), except IntentClassifier. */
export const CloudflareLive = (config: CloudflareConfig) =>
  Layer.mergeAll(
    SystemClockLive,
    IdGeneratorUuid,
    SqliteRepositories(drizzle(config.db)),
    Layer.succeed(KeyValueStore, makeWorkersKeyValueStore(config.kv)),
    SchedulerNoop,
    Layer.succeed(
      ChannelGateway,
      makeHttpChannelGateway({ adapterUrls: config.adapterUrls, fetch }),
    ),
    AgentRuntimePending,
    SidekickPending,
    Layer.succeed(WorkerLauncher, config.workerLauncher ?? noopLauncher),
    UserConnectionsUnavailable,
  );

import type { ChannelType } from "@project-os/contracts";
import {
  type AgentRuntime,
  AssetStore,
  ChannelGateway,
  KeyValueStore,
  Scheduler,
  type Sidekick,
  SkillSource,
  WorkerLauncher,
} from "@project-os/core";
import { DrizzleSqlite, schema, SqliteRepositories } from "@project-os/db-sqlite";
import {
  AgentRuntimePending,
  AssetStoreUnavailable,
  DEFAULT_ORG,
  makeAssetStore,
  IdGeneratorUuid,
  makeGithubSkillSource,
  makeHttpChannelGateway,
  noopLauncher,
  SidekickPending,
  SystemClockLive,
  UserConnectionsUnavailable,
  EmailUnavailable,
} from "@project-os/infra-local/shared";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { makeWorkersKeyValueStore } from "./kv.ts";
import { makeR2Backend } from "./r2.ts";

export { DEFAULT_ORG, makeGithubSkillSource, makeR2Backend, makeWorkersKeyValueStore };

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

/** The Drizzle db over the Worker's D1 binding. The binding is the handle; nothing is opened. */
export const DrizzleD1 = (binding: D1Database): Layer.Layer<DrizzleSqlite> =>
  Layer.sync(DrizzleSqlite, () => drizzle(binding));

/** Sends adapter requests through a service binding, so the adapter needs no public URL. */
export const serviceFetch =
  (service: Fetcher) =>
  (input: string, init?: RequestInit): Promise<Response> =>
    service.fetch(input, init);

export interface CloudflareConfig {
  /** D1 binding. Alchemy applies the migrations on deploy, so this never migrates. */
  readonly db: D1Database;
  /** Workers KV binding. */
  readonly kv: KVNamespace;
  /** Base URL per Channel Adapter (its `/reply` endpoint host). */
  readonly adapterUrls: Partial<Record<ChannelType, string>>;
  /** How adapter requests leave the Worker. Default: global `fetch`. A service binding's `fetch` goes here. */
  readonly adapterFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Starts workers for assigned tickets. Default: none (a Watcher pulls the work). */
  readonly workerLauncher?: typeof WorkerLauncher.Service;
  /**
   * R2 bucket for files people attach, and how Workers are told to download them: signed links
   * to `<publicUrl>/assets/...`. Omitted: attachments stay on their Discord links.
   */
  readonly assets?: {
    readonly bucket: R2Bucket;
    readonly publicUrl: string;
    readonly secret: string;
  };
  /** Where skills are read from. Default: GitHub, anonymously. */
  readonly skillSource?: typeof SkillSource.Service;
  /** Provides `AgentRuntime` and `Sidekick`. Default: placeholders that fail. */
  readonly agent?: Layer.Layer<AgentRuntime | Sidekick>;
}

/** A Worker has no process to keep a timer in, so `every` does nothing. Recurring work runs from a Cron Trigger. */
const SchedulerNoop = Layer.succeed(Scheduler, {
  every: () => Effect.succeed(Effect.void),
});

/** Every core port for the Cloudflare target (D1 + KV), except IntentClassifier. */
export const CloudflareLive = (config: CloudflareConfig) =>
  Layer.mergeAll(
    SystemClockLive,
    IdGeneratorUuid,
    SqliteRepositories.pipe(Layer.provide(DrizzleD1(config.db))),
    Layer.succeed(KeyValueStore, makeWorkersKeyValueStore(config.kv)),
    SchedulerNoop,
    Layer.succeed(
      ChannelGateway,
      // workerd throws "Illegal invocation" when the global `fetch` is called detached.
      makeHttpChannelGateway({
        adapterUrls: config.adapterUrls,
        fetch: config.adapterFetch ?? ((input, init) => fetch(input, init)),
      }),
    ),
    config.agent ?? Layer.merge(AgentRuntimePending, SidekickPending),
    Layer.succeed(WorkerLauncher, config.workerLauncher ?? noopLauncher),
    UserConnectionsUnavailable,
    EmailUnavailable,
    Layer.succeed(
      SkillSource,
      // workerd throws "Illegal invocation" when the global `fetch` is called detached.
      config.skillSource ?? makeGithubSkillSource({ fetch: (input, init) => fetch(input, init) }),
    ),
    config.assets
      ? Layer.succeed(
          AssetStore,
          makeAssetStore({
            backend: makeR2Backend(config.assets.bucket),
            links: { publicUrl: config.assets.publicUrl, secret: config.assets.secret },
          }),
        )
      : AssetStoreUnavailable,
  );

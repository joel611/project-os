import { type ChannelType } from "@project-os/contracts";
import { AssetStore, KeyValueStore, Scheduler, WorkerLauncher } from "@project-os/core";
import { ChannelGateway } from "@project-os/core";
import { Layer } from "effect";
import { openLocalDb, SqliteLive } from "./database.ts";
import { makeMemoryKeyValueStore } from "./kv.ts";
import { makeTimerScheduler } from "./scheduler.ts";
import { makeDiskBackend } from "./assets-disk.ts";
import {
  AgentRuntimePending,
  AssetStoreUnavailable,
  IdGeneratorUuid,
  makeAssetStore,
  makeHttpChannelGateway,
  noopLauncher,
  SidekickPending,
  SystemClockLive,
  UserConnectionsUnavailable,
} from "./shared.ts";

export { SystemClockLive, UserConnectionsUnavailable, openLocalDb };
export { DEFAULT_ORG, ensureOrg } from "./org.ts";

export interface LocalConfig {
  /** SQLite file path; created and migrated on start. */
  readonly dbPath: string;
  /** Base URL per Channel Adapter (its `/reply` endpoint host). */
  readonly adapterUrls: Partial<Record<ChannelType, string>>;
  /** Starts workers for assigned tickets. Default: none (the host Watcher pulls local work). */
  readonly workerLauncher?: typeof WorkerLauncher.Service;
  /**
   * Where files people attach are kept, and how Workers are told to download them: signed links
   * to `<publicUrl>/assets/...`. Omitted: attachments stay on their Discord links.
   */
  readonly assets?: {
    readonly dir: string;
    readonly publicUrl: string;
    readonly secret: string;
    /** Test hook: where files are downloaded from. Default: global `fetch`. */
    readonly fetch?: (url: string) => Promise<Response>;
  };
}

const KeyValueStoreMemory = Layer.sync(KeyValueStore, () => makeMemoryKeyValueStore(Date.now));

const SchedulerTimer = Layer.succeed(Scheduler, makeTimerScheduler());

/** Every core port for the local target (Bun + bun:sqlite), except IntentClassifier. */
export const LocalLive = (config: LocalConfig) =>
  Layer.mergeAll(
    SystemClockLive,
    IdGeneratorUuid,
    SqliteLive(config.dbPath),
    KeyValueStoreMemory,
    SchedulerTimer,
    Layer.succeed(
      ChannelGateway,
      makeHttpChannelGateway({ adapterUrls: config.adapterUrls, fetch }),
    ),
    AgentRuntimePending,
    SidekickPending,
    Layer.succeed(WorkerLauncher, config.workerLauncher ?? noopLauncher),
    UserConnectionsUnavailable,
    config.assets
      ? Layer.succeed(
          AssetStore,
          makeAssetStore({
            backend: makeDiskBackend(config.assets.dir),
            links: {
              // Read per link: the Coordinator's URL may only be known after it listens.
              get publicUrl() {
                return config.assets!.publicUrl;
              },
              secret: config.assets.secret,
            },
            ...(config.assets.fetch && { fetch: config.assets.fetch }),
          }),
        )
      : AssetStoreUnavailable,
  );

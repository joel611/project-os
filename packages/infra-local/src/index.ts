import { type ChannelType } from "@project-os/contracts";
import { KeyValueStore, Scheduler, WorkerLauncher } from "@project-os/core";
import { ChannelGateway } from "@project-os/core";
import { Layer } from "effect";
import { openLocalDb, SqliteLive } from "./database.ts";
import { makeMemoryKeyValueStore } from "./kv.ts";
import { makeTimerScheduler } from "./scheduler.ts";
import {
  AgentRuntimePending,
  IdGeneratorUuid,
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
  );

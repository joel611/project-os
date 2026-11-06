import { type ChannelType } from "@project-os/contracts";
import {
  AgentRuntime,
  ConnectionsUnavailable,
  IdGenerator,
  KeyValueStore,
  Scheduler,
  UserConnections,
  WorkerLauncher,
} from "@project-os/core";
import { ChannelGateway } from "@project-os/core";
import { Effect, Layer } from "effect";
import { SystemClockLive } from "./clock.ts";
import { openLocalDb, SqliteLive } from "./database.ts";
import { makeHttpChannelGateway } from "./gateway.ts";
import { makeMemoryKeyValueStore } from "./kv.ts";
import { makeTimerScheduler } from "./scheduler.ts";

export { SystemClockLive, openLocalDb };
export { DEFAULT_ORG, ensureOrg } from "./org.ts";

export interface LocalConfig {
  /** SQLite file path; created and migrated on start. */
  readonly dbPath: string;
  /** Base URL per Channel Adapter (its `/reply` endpoint host). */
  readonly adapterUrls: Partial<Record<ChannelType, string>>;
}

const IdGeneratorUuid = Layer.succeed(IdGenerator, {
  next: Effect.sync(() => crypto.randomUUID()),
});

const KeyValueStoreMemory = Layer.sync(KeyValueStore, () => makeMemoryKeyValueStore(Date.now));

const SchedulerTimer = Layer.succeed(Scheduler, makeTimerScheduler());

const WorkerLauncherNoop = Layer.succeed(WorkerLauncher, { launch: () => Effect.void });

/** Placeholder until the agent-runtime ticket (#14) supplies the in-process implementation. */
const AgentRuntimePending = Layer.succeed(AgentRuntime, {
  respond: () => Effect.die(new Error("AgentRuntime not wired yet (see #14)")),
});

/** Placeholder until an entry file supplies account linking (`@project-os/auth`). */
const notConfigured = () =>
  Effect.fail(new ConnectionsUnavailable({ message: "Account linking is not configured." }));
export const UserConnectionsUnavailable = Layer.succeed(UserConnections, {
  connectUrl: notConfigured,
  list: () => Effect.succeed([]),
  disconnect: () => Effect.succeed(false),
  accessToken: notConfigured,
});

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
    WorkerLauncherNoop,
    UserConnectionsUnavailable,
  );

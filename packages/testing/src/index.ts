import type { ConnectionProvider } from "@project-os/contracts";
import {
  Clock,
  type Executor,
  IntentClassifier,
  LaunchFailed,
  type SandboxPoolEntry,
  WorkerLauncher,
} from "@project-os/core";
import { Effect, Layer } from "effect";
import {
  AgentRuntimeEcho,
  ChannelMessageRepositoryInMemory,
  IdGeneratorSequential,
  IntentClassifierFake,
  KeyValueStoreInMemory,
  makeAssetStoreRecording,
  makeChannelDigesterRecording,
  makeChannelGatewayRecording,
  makeSidekickRecording,
  makeUserConnectionsInMemory,
  AuditLogRepositoryInMemory,
  MemoryRepositoryInMemory,
  ProjectRepositoryInMemory,
  ProjectSourceRepositoryInMemory,
  SchedulerNoop,
  TicketRepositoryInMemory,
  WorkerRepositoryInMemory,
} from "./in-memory.ts";

export * from "./in-memory.ts";

/** Fixed clock for deterministic tests. */
export const fixedClock = (date: Date) => Layer.succeed(Clock, { now: Effect.succeed(date) });

/**
 * Every port, in memory. State is fresh per Layer build.
 * `sent` collects replies passed to `ChannelGateway.send`; `createdChannels` the channels
 * `ChannelGateway.createChannel` was asked to create; `createdThreads` the threads
 * `ChannelGateway.createThread` was asked to open; `reactions` the reactions
 * `ChannelGateway.react` was asked to add; `launched` the `WorkerLauncher.launch` calls.
 */
export const makeTestLayer = (options?: {
  readonly now?: Date;
  /** Replace the default classifier (always `general` @ 1.0). */
  readonly classifier?: Layer.Layer<IntentClassifier>;
  /** Make `ChannelGateway.createChannel` fail with this message. */
  readonly failChannelCreate?: string;
  /** Make `ChannelGateway.createThread` fail with this message. */
  readonly failThreadCreate?: string;
  /** Make `ChannelGateway.react` fail with this message. */
  readonly failReact?: string;
  /** Make `ChannelGateway.ask` fail with this message. */
  readonly failPrompt?: string;
  /** Make every `AssetStore.ingest` fail with this message. */
  readonly failAssetStore?: string;
  /** Make every Channel Digest model call fail with this message. */
  readonly failDigest?: string;
  /** Make every Sidekick turn fail with this message. */
  readonly failSidekick?: string;
  /** Have each Sidekick turn ask for this provider's token, as one of its tools would. */
  readonly sidekickProbe?: ConnectionProvider;
  /** Make `WorkerLauncher.launch` fail with this message, until `setLaunchFailure` says otherwise. */
  readonly failLaunch?: string;
  /** The launcher's sandbox pool. Default: empty (no sandbox provider configured). */
  readonly sandboxPool?: ReadonlyArray<SandboxPoolEntry>;
}) => {
  const launched: Array<Parameters<typeof WorkerLauncher.Service.launch>[0]> = [];
  const launchAttempts: Array<Parameters<typeof WorkerLauncher.Service.launch>[0]> = [];
  let launchFailure = options?.failLaunch;
  const sidekick = makeSidekickRecording({
    ...(options?.failSidekick === undefined ? {} : { fail: options.failSidekick }),
    ...(options?.sidekickProbe === undefined ? {} : { probe: options.sidekickProbe }),
  });
  const gateway = makeChannelGatewayRecording({
    ...(options?.failChannelCreate === undefined ? {} : { failCreate: options.failChannelCreate }),
    ...(options?.failThreadCreate === undefined ? {} : { failThread: options.failThreadCreate }),
    ...(options?.failReact === undefined ? {} : { failReact: options.failReact }),
    ...(options?.failPrompt === undefined ? {} : { failPrompt: options.failPrompt }),
  });
  const digester = makeChannelDigesterRecording(
    options?.failDigest === undefined ? {} : { fail: options.failDigest },
  );
  const connections = makeUserConnectionsInMemory();
  const assets = makeAssetStoreRecording(
    options?.failAssetStore === undefined ? {} : { fail: options.failAssetStore },
  );
  const layer = Layer.mergeAll(
    fixedClock(options?.now ?? new Date("2026-11-04T00:00:00.000Z")),
    TicketRepositoryInMemory,
    ProjectRepositoryInMemory,
    ProjectSourceRepositoryInMemory,
    MemoryRepositoryInMemory,
    AuditLogRepositoryInMemory,
    ChannelMessageRepositoryInMemory,
    WorkerRepositoryInMemory,
    KeyValueStoreInMemory,
    gateway.layer,
    SchedulerNoop,
    options?.classifier ?? IntentClassifierFake(),
    AgentRuntimeEcho,
    Layer.succeed(WorkerLauncher, {
      pool: Effect.succeed(options?.sandboxPool ?? []),
      launch: (input) =>
        Effect.suspend(() => {
          launchAttempts.push(input);
          if (launchFailure !== undefined) {
            return Effect.fail(new LaunchFailed({ message: launchFailure }));
          }
          launched.push(input);
          return Effect.void;
        }),
    }),
    sidekick.layer,
    digester.layer,
    IdGeneratorSequential,
    connections.layer,
    assets.layer,
  );
  return {
    layer,
    /** Files `AssetStore.ingest` copied: storage key to source URL. */
    storedAssets: assets.stored,
    /** Calls the Channel Digest made to its model. */
    digestCalls: digester.calls,
    /** Turns the Sidekick took. */
    sidekickCalls: sidekick.calls,
    sent: gateway.sent,
    createdChannels: gateway.created,
    launched,
    /** Every `WorkerLauncher.launch` call, including the ones that failed. */
    launchAttempts,
    /** Make later launches fail with this message, or succeed again (undefined). */
    setLaunchFailure: (message: string | undefined) => {
      launchFailure = message;
    },
    /** Link a person's account, as if they had finished `/connect`. */
    link: connections.link,
    linkShared: connections.linkShared,
    createdThreads: gateway.threads,
    reactions: gateway.reactions,
    /** Prompts passed to `ChannelGateway.ask`. */
    prompts: gateway.prompts,
  };
};

/** Classifier returning a fixed intent / confidence / executor. */
export const classifierReturning = (
  intent: string,
  confidence = 1,
  executor?: Executor,
): Layer.Layer<IntentClassifier> =>
  Layer.succeed(IntentClassifier, {
    classify: () =>
      Effect.succeed({
        intent,
        confidence,
        ...(executor ? { executor } : {}),
      }),
  });

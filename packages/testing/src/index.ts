import { Clock, IntentClassifier, WorkerLauncher, type WorkerType } from "@project-os/core";
import { Effect, Layer } from "effect";
import {
  AgentRuntimeEcho,
  IdGeneratorSequential,
  IntentClassifierFake,
  KeyValueStoreInMemory,
  makeChannelGatewayRecording,
  makeUserConnectionsInMemory,
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
}) => {
  const launched: Array<Parameters<typeof WorkerLauncher.Service.launch>[0]> = [];
  const gateway = makeChannelGatewayRecording({
    ...(options?.failChannelCreate === undefined ? {} : { failCreate: options.failChannelCreate }),
    ...(options?.failThreadCreate === undefined ? {} : { failThread: options.failThreadCreate }),
    ...(options?.failReact === undefined ? {} : { failReact: options.failReact }),
  });
  const connections = makeUserConnectionsInMemory();
  const layer = Layer.mergeAll(
    fixedClock(options?.now ?? new Date("2026-11-04T00:00:00.000Z")),
    TicketRepositoryInMemory,
    ProjectRepositoryInMemory,
    ProjectSourceRepositoryInMemory,
    MemoryRepositoryInMemory,
    WorkerRepositoryInMemory,
    KeyValueStoreInMemory,
    gateway.layer,
    SchedulerNoop,
    options?.classifier ?? IntentClassifierFake(),
    AgentRuntimeEcho,
    Layer.succeed(WorkerLauncher, {
      launch: (input) => Effect.sync(() => void launched.push(input)),
    }),
    IdGeneratorSequential,
    connections.layer,
  );
  return {
    layer,
    sent: gateway.sent,
    createdChannels: gateway.created,
    launched,
    /** Link a person's account, as if they had finished `/connect`. */
    link: connections.link,
    createdThreads: gateway.threads,
    reactions: gateway.reactions,
  };
};

/** Classifier returning a fixed intent / confidence / workerType. */
export const classifierReturning = (
  intent: string,
  confidence = 1,
  workerType?: WorkerType,
): Layer.Layer<IntentClassifier> =>
  Layer.succeed(IntentClassifier, {
    classify: () => Effect.succeed({ intent, confidence, ...(workerType ? { workerType } : {}) }),
  });

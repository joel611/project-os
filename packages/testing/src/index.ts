import { Clock, IntentClassifier, type WorkerType } from "@project-os/core";
import { Effect, Layer } from "effect";
import {
  AgentRuntimeEcho,
  IdGeneratorSequential,
  IntentClassifierFake,
  KeyValueStoreInMemory,
  makeChannelGatewayRecording,
  MemoryRepositoryInMemory,
  ProjectRepositoryInMemory,
  ProjectSourceRepositoryInMemory,
  SchedulerNoop,
  TicketRepositoryInMemory,
  WorkerLauncherNoop,
  WorkerRepositoryInMemory,
} from "./in-memory.ts";

export * from "./in-memory.ts";

/** Fixed clock for deterministic tests. */
export const fixedClock = (date: Date) => Layer.succeed(Clock, { now: Effect.succeed(date) });

/**
 * Every port, in memory. State is fresh per Layer build.
 * `sent` collects replies passed to `ChannelGateway.send`; `createdChannels` the channels
 * `ChannelGateway.createChannel` was asked to create.
 */
export const makeTestLayer = (options?: {
  readonly now?: Date;
  /** Replace the default classifier (always `general` @ 1.0). */
  readonly classifier?: Layer.Layer<IntentClassifier>;
  /** Make `ChannelGateway.createChannel` fail with this message. */
  readonly failChannelCreate?: string;
}) => {
  const gateway = makeChannelGatewayRecording(
    options?.failChannelCreate === undefined ? {} : { failCreate: options.failChannelCreate },
  );
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
    WorkerLauncherNoop,
    IdGeneratorSequential,
  );
  return { layer, sent: gateway.sent, createdChannels: gateway.created };
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

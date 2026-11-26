// Runtime-neutral pieces of the local Layer. No `bun:sqlite`, so the Cloudflare target can
// import them through `@project-os/infra-local/shared` without dragging Bun into a Worker.
import {
  AgentRuntime,
  ConnectionsUnavailable,
  EmailClassifier,
  EmailClassifierError,
  EmailSource,
  EmailSourceError,
  IdGenerator,
  Sidekick,
  SidekickError,
  UserConnections,
  type WorkerLauncher,
} from "@project-os/core";
import { Effect, Layer } from "effect";

export { SystemClockLive } from "./clock.ts";
export { makeHttpChannelGateway } from "./gateway.ts";
export { makeGithubSkillSource, type GithubSkillSourceConfig } from "./skills-github.ts";
export {
  AssetStoreUnavailable,
  type AssetLinksConfig,
  type AssetStoreConfig,
  type BlobBackend,
  makeAssetStore,
} from "./assets.ts";

/** The single org of the POC. Projects need one (FK), and no use case creates orgs. */
export const DEFAULT_ORG = { id: "default-org", name: "Default Org" } as const;

export const IdGeneratorUuid = Layer.succeed(IdGenerator, {
  next: Effect.sync(() => crypto.randomUUID()),
});

export const noopLauncher: typeof WorkerLauncher.Service = {
  pool: Effect.succeed([]),
  launch: () => Effect.void,
};

/** Placeholder until an entry file supplies the agent runtime, which also provides the Sidekick. */
export const SidekickPending = Layer.succeed(Sidekick, {
  answer: () => Effect.fail(new SidekickError({ message: "The Sidekick is not wired here." })),
});

/** Placeholder until the agent-runtime ticket (#14) supplies the in-process implementation. */
export const AgentRuntimePending = Layer.succeed(AgentRuntime, {
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

/** Placeholders until an entry file supplies mailbox reading and the email classifier. */
export const EmailUnavailable = Layer.mergeAll(
  Layer.succeed(EmailSource, {
    sync: () =>
      Effect.fail(new EmailSourceError({ message: "Email is not configured.", reconnect: false })),
    labels: () =>
      Effect.fail(new EmailSourceError({ message: "Email is not configured.", reconnect: false })),
  }),
  Layer.succeed(EmailClassifier, {
    classify: () => Effect.fail(new EmailClassifierError({ message: "Email is not configured." })),
  }),
);

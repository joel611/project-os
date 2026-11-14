import type { Models } from "@earendil-works/pi-ai";
import { type AgentRuntimeOptions, makeAgentRuntime, newModels } from "@project-os/agent-runtime";
import { envBool, modelConfig } from "@project-os/config";
import {
  AgentRuntime,
  AgentRuntimeError,
  Sidekick,
  SidekickError,
  type SidekickToken,
} from "@project-os/core";
import type { ConnectionProvider } from "@project-os/contracts";
import { CloudflareLive, DEFAULT_ORG, serviceFetch } from "@project-os/infra-cloudflare";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeAdminActions } from "./admin/actions.ts";

// One `PiAgent` per session (`project:<id>`, `admin:<channel>`, `sidekick:<ticket>`) is the sole
// owner of that session's Pi storage.

interface Bindings {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly DISCORD_GATEWAY?: Fetcher;
}

/** A failure can't cross the Durable Object RPC as a typed error, so it travels as data. */
type Reply =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

const encodeReply = Effect.match({
  onSuccess: (text: string): Reply => ({ ok: true, text }),
  onFailure: (e: { readonly message: string }): Reply => ({ ok: false, message: e.message }),
});

const decodeReply =
  <E>(failure: (message: string) => E) =>
  (reply: Reply) =>
    reply.ok ? Effect.succeed(reply.text) : Effect.fail(failure(reply.message));

export class PiAgent extends DurableObject<Bindings> {
  readonly #runtime: ManagedRuntime.ManagedRuntime<AgentRuntime | Sidekick, never>;

  constructor(ctx: DurableObjectState, bindings: Bindings) {
    super(ctx, bindings);
    const core = ManagedRuntime.make(
      CloudflareLive({
        db: bindings.DB,
        kv: bindings.KV,
        adapterUrls: process.env.DISCORD_SPLIT_GATEWAY_URL
          ? { discord: process.env.DISCORD_SPLIT_GATEWAY_URL }
          : {},
        ...(bindings.DISCORD_GATEWAY && { adapterFetch: serviceFetch(bindings.DISCORD_GATEWAY) }),
      }),
    );
    const adminActions = makeAdminActions({
      run: (effect) => core.runPromise(effect as Effect.Effect<never, never, never>),
      orgId: DEFAULT_ORG.id,
      autoCreateChannel: envBool("DISCORD_PROJECT_CHANNEL_AUTO_CREATE", true),
    });
    const agent = Layer.unwrap(
      Effect.promise(() => openDurableObjectSqliteStorage(ctx.storage)).pipe(
        Effect.map((storage) =>
          makeAgentRuntime({
            storage,
            ...this.chat(),
            adminActions,
          }),
        ),
      ),
    );
    this.#runtime = ManagedRuntime.make(Layer.orDie(agent));
  }

  protected chat(): { readonly models: Models; readonly model: AgentRuntimeOptions["model"] } {
    return {
      models: newModels(),
      model: modelConfig().default,
    };
  }

  respond(input: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly requestId?: string;
  }): Promise<Reply> {
    return this.#runtime.runPromise(AgentRuntime.use((r) => r.respond(input)).pipe(encodeReply));
  }

  answer(input: {
    readonly ticketId: string;
    readonly prompt: string;
    readonly requestId?: string;
    readonly token: (provider: ConnectionProvider) => Promise<SidekickToken>;
  }): Promise<Reply> {
    return this.#runtime.runPromise(Sidekick.use((s) => s.answer(input)).pipe(encodeReply));
  }
}

export const durableAgentRuntime = (
  agents: DurableObjectNamespace<PiAgent>,
): Layer.Layer<AgentRuntime | Sidekick> =>
  Layer.mergeAll(
    Layer.succeed(AgentRuntime, {
      respond: (input) =>
        Effect.tryPromise({
          try: async (): Promise<Reply> => await agents.getByName(input.sessionId).respond(input),
          catch: (e) => new AgentRuntimeError({ message: String(e) }),
        }).pipe(Effect.flatMap(decodeReply((message) => new AgentRuntimeError({ message })))),
    }),
    Layer.succeed(Sidekick, {
      answer: (input) =>
        Effect.tryPromise({
          try: async (): Promise<Reply> =>
            await agents.getByName(`sidekick:${input.ticketId}`).answer(input),
          catch: (e) => new SidekickError({ message: String(e) }),
        }).pipe(Effect.flatMap(decodeReply((message) => new SidekickError({ message })))),
    }),
  );

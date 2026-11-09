import type { Models } from "@earendil-works/pi-ai";
import { type AgentRuntimeOptions, makeAgentRuntime, newModels } from "@project-os/agent-runtime";
import { env, envBool } from "@project-os/config";
import {
  AgentRuntime,
  AgentRuntimeError,
  Sidekick,
  SidekickError,
  type SidekickToken,
} from "@project-os/core";
import type { ConnectionProvider } from "@project-os/contracts";
import { CloudflareLive, DEFAULT_ORG } from "@project-os/infra-cloudflare";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeAdminActions } from "./admin/actions.ts";

// Pi Durable on Workers. Pi's storage must live in a SQLite-backed Durable Object, so each
// session (`project:<id>`, `admin:<channel>`, `sidekick:<ticket>`) gets one `PiAgent` that owns
// its Harness. The Worker reaches it through `durableAgentRuntime`.

interface Bindings {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
}

/** Errors cross the RPC boundary as values, so the Worker rebuilds the typed error. */
type Reply =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

export class PiAgent extends DurableObject<Bindings> {
  readonly #runtime: ManagedRuntime.ManagedRuntime<AgentRuntime | Sidekick, never>;

  constructor(ctx: DurableObjectState, bindings: Bindings) {
    super(ctx, bindings);
    // Admin tools act on the same D1 and KV as the Worker. The Pi layer is not part of this one.
    const core = ManagedRuntime.make(
      CloudflareLive({
        db: bindings.DB,
        kv: bindings.KV,
        adapterUrls: process.env.DISCORD_SPLIT_GATEWAY_URL
          ? { discord: process.env.DISCORD_SPLIT_GATEWAY_URL }
          : {},
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

  /** The chat model and its provider. A test subclass swaps in a faux one. */
  protected chat(): { readonly models: Models; readonly model: AgentRuntimeOptions["model"] } {
    return {
      models: newModels(),
      model: { provider: env("CHAT_MODEL_PROVIDER", "openrouter"), modelId: env("CHAT_MODEL_ID") },
    };
  }

  respond(input: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly requestId?: string;
  }): Promise<Reply> {
    return this.#runtime.runPromise(
      AgentRuntime.use((r) => r.respond(input)).pipe(
        Effect.match({
          onSuccess: (text): Reply => ({ ok: true, text }),
          onFailure: (e): Reply => ({ ok: false, message: e.message }),
        }),
      ),
    );
  }

  answer(input: {
    readonly ticketId: string;
    readonly prompt: string;
    readonly requestId?: string;
    /** An RPC stub back to the Worker: the requester's token, fetched only when a tool needs it. */
    readonly token: (provider: ConnectionProvider) => Promise<SidekickToken>;
  }): Promise<Reply> {
    return this.#runtime.runPromise(
      Sidekick.use((s) => s.answer(input)).pipe(
        Effect.match({
          onSuccess: (text): Reply => ({ ok: true, text }),
          onFailure: (e): Reply => ({ ok: false, message: e.message }),
        }),
      ),
    );
  }
}

/** `AgentRuntime` and `Sidekick` for the Worker, served by the session's `PiAgent`. */
export const durableAgentRuntime = (
  agents: DurableObjectNamespace<PiAgent>,
): Layer.Layer<AgentRuntime | Sidekick> =>
  Layer.mergeAll(
    Layer.succeed(AgentRuntime, {
      respond: (input) =>
        Effect.tryPromise({
          try: async (): Promise<Reply> => await agents.getByName(input.sessionId).respond(input),
          catch: (e) => new AgentRuntimeError({ message: String(e) }),
        }).pipe(
          Effect.flatMap((reply) =>
            reply.ok
              ? Effect.succeed(reply.text)
              : Effect.fail(new AgentRuntimeError({ message: reply.message })),
          ),
        ),
    }),
    Layer.succeed(Sidekick, {
      answer: (input) =>
        Effect.tryPromise({
          try: async (): Promise<Reply> =>
            await agents.getByName(`sidekick:${input.ticketId}`).answer(input),
          catch: (e) => new SidekickError({ message: String(e) }),
        }).pipe(
          Effect.flatMap((reply) =>
            reply.ok
              ? Effect.succeed(reply.text)
              : Effect.fail(new SidekickError({ message: reply.message })),
          ),
        ),
    }),
  );

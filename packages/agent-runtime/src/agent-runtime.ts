import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  createRegistry,
  defineDoc,
  defineExtension,
  Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { AgentRuntime, AgentRuntimeError } from "@project-os/core";
import { Effect, Layer } from "effect";
import { type AdminActions, makeAdminExtension } from "./admin-tools.ts";

export interface AgentRuntimeOptions {
  /** Pi storage. One process owns it at a time; the Harness is opened once per Coordinator. */
  readonly storage: Storage;
  readonly models: Models;
  /** Chat model (config). */
  readonly model: { readonly provider: string; readonly modelId: string };
  /** Coordinator actions exposed as tools to `admin:*` sessions. */
  readonly adminActions?: AdminActions;
  readonly instructions?: string;
  /** Pi telemetry sink, e.g. `makeOtelTelemetry(...)`. Omitted: no-op. */
  readonly telemetry?: TelemetryContext | undefined;
}

/** Maps a session key (`project:<id>`, `admin:<channel>`) to its Pi conversation, durably. */
const Sessions = defineDoc<{ byKey: Record<string, number> }>({
  kind: "project-os.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ byKey: {} }),
  checkpointWhen: () => true,
});

const fail = (e: unknown) =>
  new AgentRuntimeError({ message: e instanceof Error ? e.message : String(e) });

const ADMIN_PREFIX = "admin:";

/**
 * Pi Durable behind the `AgentRuntime` port. One conversation per session key, submissions
 * keyed by `requestId`, resumed on open. Admin sessions get the Coordinator action tools;
 * project sessions get none (replies leave through `ChannelGateway`, never through Pi).
 */
export const makeAgentRuntime = (options: AgentRuntimeOptions) =>
  Layer.effect(
    AgentRuntime,
    Effect.gen(function* () {
      const admin = defineExtension({ name: "project-os-none" });
      const registry = createRegistry();
      const adminExtension = options.adminActions
        ? makeAdminExtension(options.adminActions)
        : undefined;
      if (adminExtension) registry.install(adminExtension);
      registry.install(admin);

      const harness = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const h = await Harness.open(
              options.storage,
              {
                models: options.models,
                registry,
                ...(options.telemetry ? { telemetry: options.telemetry } : {}),
              },
              context,
            );
            h.resume();
            return h;
          },
          catch: fail,
        }),
        (h) => Effect.promise(() => h.close(context)),
      );

      const agentFor = (key: string) => ({
        model: options.model,
        extensions: key.startsWith(ADMIN_PREFIX) && adminExtension ? [adminExtension] : [admin],
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      });

      // Serialise lookups so two first messages for one session do not create two conversations.
      const inflight = new Map<string, Promise<Conversation>>();
      const lookup = async (key: string): Promise<Conversation> => {
        const known = (await harness.snapshot(Sessions, context))?.byKey[key];
        const existing =
          known === undefined
            ? undefined
            : await harness.conversation(known as ConversationId, context);
        if (existing) return existing;
        const created = await harness.createConversation(
          { ownership: { kind: "ownerless" }, agent: agentFor(key) },
          context,
        );
        await harness.commit(async (tx) => {
          (await tx.doc(Sessions)).byKey[key] = created.id as unknown as number;
        }, context);
        return created;
      };
      const conversationFor = (key: string): Promise<Conversation> => {
        const pending = inflight.get(key) ?? lookup(key);
        inflight.set(key, pending);
        return pending.finally(() => {
          if (inflight.get(key) === pending) inflight.delete(key);
        });
      };

      const respond = async (input: {
        readonly sessionId: string;
        readonly prompt: string;
        readonly requestId?: string;
      }): Promise<string> => {
        const conversation = await conversationFor(input.sessionId);
        const submission = await conversation.submit(
          {
            type: "input",
            content: input.prompt,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          },
          context,
        );
        const settled = await submission.wait(context);
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`no answer (${settled.status})`);
        }
        const answer = await conversation.commit(
          (tx) => tx.entry(AssistantEntry, settled.answer),
          context,
        );
        // A `done` input always has its assistant answer entry.
        const message = answer?.model?.[0] as AssistantMessage;
        return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      };

      return { respond: (input) => Effect.tryPromise({ try: () => respond(input), catch: fail }) };
    }),
  );

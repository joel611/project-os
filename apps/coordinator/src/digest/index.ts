import { type CompleteClient, makeChannelDigester } from "@project-os/agent-runtime/classifier";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ChannelDigestConfig, digestChannels, Scheduler } from "@project-os/core";
import { Effect } from "effect";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The Channel Digest's model: `CHANNEL_DIGEST_MODEL_PROVIDER` / `CHANNEL_DIGEST_MODEL_ID`,
 * falling back to the chat model (`CHAT_MODEL_PROVIDER` / `CHAT_MODEL_ID`). Undefined when
 * neither model id is set: the digest is then off, and no channel messages are kept.
 */
export const channelDigesterFromEnv = (
  models: CompleteClient & { getModel(provider: string, id: string): Model<Api> | undefined },
  env: Env,
) => {
  const provider = env.CHANNEL_DIGEST_MODEL_PROVIDER || env.CHAT_MODEL_PROVIDER || "openrouter";
  const modelId = env.CHANNEL_DIGEST_MODEL_ID || env.CHAT_MODEL_ID;
  if (!modelId) {
    console.log("Channel Digest off: set CHANNEL_DIGEST_MODEL_ID or CHAT_MODEL_ID to enable it");
    return undefined;
  }
  const model = models.getModel(provider, modelId);
  if (!model) throw new Error(`Unknown Channel Digest model ${provider}/${modelId}`);
  return makeChannelDigester({ client: models, model });
};

type Digest = ReturnType<typeof digestChannels>;

/** Logs what a digest run saved; failures inside are already logged per project. */
export const digestAndLog = (config: ChannelDigestConfig) =>
  digestChannels(config).pipe(
    Effect.tap((runs) =>
      Effect.forEach(
        runs.filter((r) => r.error === undefined),
        (r) =>
          Effect.logInfo(
            `channel digest: project ${r.projectId} read ${r.messages} messages, saved ${r.saved}`,
          ),
        { discard: true },
      ),
    ),
    Effect.asVoid,
  );

/**
 * Runs the Channel Digest every `everyMs` via the `Scheduler` port (Bun). On Cloudflare the
 * Cron Trigger calls `digestAndLog` instead. Returns the stop effect.
 */
export const startChannelDigest = (config: ChannelDigestConfig & { readonly everyMs: number }) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler;
    const context = yield* Effect.context<Effect.Services<Digest>>();
    return yield* scheduler.every(
      "channel-digest",
      config.everyMs,
      digestAndLog(config).pipe(
        Effect.provideContext(context),
        Effect.catchCause((cause) => Effect.logError("channel digest failed", cause)),
      ),
    );
  });

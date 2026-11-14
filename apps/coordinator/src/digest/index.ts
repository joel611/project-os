import { type CompleteClient, makeChannelDigester } from "@project-os/agent-runtime/classifier";
import type { Api, Model } from "@earendil-works/pi-ai";
import { formatModelRef, type ModelRef } from "@project-os/config";
import { type ChannelDigestConfig, digestChannels, Scheduler } from "@project-os/core";
import { Effect } from "effect";

/** The Channel Digest's model: `CHANNEL_DIGEST_MODEL`, else `DEFAULT_MODEL` (`modelConfig`). */
export const channelDigester = (
  models: CompleteClient & { getModel(provider: string, id: string): Model<Api> | undefined },
  ref: ModelRef,
) => {
  const model = models.getModel(ref.provider, ref.modelId);
  if (!model) throw new Error(`Unknown Channel Digest model ${formatModelRef(ref)}`);
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

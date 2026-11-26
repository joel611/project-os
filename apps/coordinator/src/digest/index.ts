import { type CompleteClient, makeChannelDigester } from "@project-os/agent-runtime/classifier";
import type { Api, Model } from "@earendil-works/pi-ai";
import { formatModelRef, type ModelRef } from "@project-os/config";
import { type ChannelDigestConfig, digestChannels } from "@project-os/core";
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

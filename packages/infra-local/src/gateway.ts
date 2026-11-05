import { CreatedChannel, type ChannelType } from "@project-os/contracts";
import { ChannelCreateFailed, type ChannelGateway } from "@project-os/core";
import { Effect, Schema } from "effect";

export interface HttpGatewayConfig {
  /** Base URL of each Channel Adapter's reply endpoint host. */
  readonly adapterUrls: Partial<Record<ChannelType, string>>;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const decodeCreated = Schema.decodeUnknownOption(CreatedChannel);

const baseUrl = (config: HttpGatewayConfig, channelType: ChannelType) => {
  const base = config.adapterUrls[channelType];
  return base === undefined ? undefined : base.replace(/\/+$/, "");
};

/**
 * POSTs reply instructions to `<adapter>/reply` (delivery failures are defects) and channel
 * creation requests to `<adapter>/channels` (failures are `ChannelCreateFailed`, so the admin
 * dialogue can report them).
 */
export const makeHttpChannelGateway = (
  config: HttpGatewayConfig,
): typeof ChannelGateway.Service => ({
  send: (reply) =>
    Effect.promise(async () => {
      const base = config.adapterUrls[reply.channelType];
      if (base === undefined) throw new Error(`No adapter URL for channel ${reply.channelType}`);
      const response = await config.fetch(`${base.replace(/\/+$/, "")}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reply),
      });
      if (!response.ok) throw new Error(`Adapter ${reply.channelType} replied ${response.status}`);
    }),
  createChannel: (request) =>
    Effect.tryPromise({
      try: async () => {
        const base = baseUrl(config, request.channelType);
        if (base === undefined)
          throw new Error(`No adapter URL for channel ${request.channelType}`);
        const response = await config.fetch(`${base}/channels`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          const detail =
            typeof body === "object" && body !== null && "error" in body ? `: ${body.error}` : "";
          throw new Error(`Adapter ${request.channelType} replied ${response.status}${detail}`);
        }
        const created = decodeCreated(body);
        if (created._tag === "None") throw new Error("Adapter returned an invalid channel");
        return created.value;
      },
      catch: (err) =>
        new ChannelCreateFailed({
          channelType: request.channelType,
          message: err instanceof Error ? err.message : String(err),
        }),
    }),
});

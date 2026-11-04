import type { ChannelType } from "@project-os/contracts";
import type { ChannelGateway } from "@project-os/core";
import { Effect } from "effect";

export interface HttpGatewayConfig {
  /** Base URL of each Channel Adapter's reply endpoint host. */
  readonly adapterUrls: Partial<Record<ChannelType, string>>;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/** POSTs reply instructions to `<adapter>/reply`. Delivery failures are defects. */
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
});

import { CreatedChannel, CreatedThread, type ChannelType } from "@project-os/contracts";
import { ChannelCreateFailed, ThreadCreateFailed, type ChannelGateway } from "@project-os/core";
import { Effect, Schema } from "effect";

export interface HttpGatewayConfig {
  /** Base URL of each Channel Adapter's reply endpoint host. */
  readonly adapterUrls: Partial<Record<ChannelType, string>>;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const decodeCreated = Schema.decodeUnknownOption(CreatedChannel);
const decodeThread = Schema.decodeUnknownOption(CreatedThread);

const baseUrl = (config: HttpGatewayConfig, channelType: ChannelType) => {
  const base = config.adapterUrls[channelType];
  return base === undefined ? undefined : base.replace(/\/+$/, "");
};

/** POSTs `request` to `<adapter><path>` and returns the decoded body; throws on any failure. */
const postForResult = async <A>(
  config: HttpGatewayConfig,
  request: { readonly channelType: ChannelType },
  path: string,
  decode: (body: unknown) => { _tag: "Some"; value: A } | { _tag: "None" },
  what: string,
): Promise<A> => {
  const base = baseUrl(config, request.channelType);
  if (base === undefined) throw new Error(`No adapter URL for channel ${request.channelType}`);
  const response = await config.fetch(`${base}${path}`, {
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
  const decoded = decode(body);
  if (decoded._tag === "None") throw new Error(`Adapter returned an invalid ${what}`);
  return decoded.value;
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * POSTs reply instructions to `<adapter>/reply` (delivery failures are defects), channel
 * creation requests to `<adapter>/channels` (failures are `ChannelCreateFailed`, so the admin
 * dialogue can report them), and thread requests to `<adapter>/threads` (`ThreadCreateFailed`).
 */
export const makeHttpChannelGateway = (
  config: HttpGatewayConfig,
): typeof ChannelGateway.Service => ({
  send: (reply) =>
    Effect.promise(async () => {
      const base = baseUrl(config, reply.channelType);
      if (base === undefined) throw new Error(`No adapter URL for channel ${reply.channelType}`);
      const response = await config.fetch(`${base}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reply),
      });
      if (!response.ok) throw new Error(`Adapter ${reply.channelType} replied ${response.status}`);
    }),
  createChannel: (request) =>
    Effect.tryPromise({
      try: () => postForResult(config, request, "/channels", decodeCreated, "channel"),
      catch: (err) =>
        new ChannelCreateFailed({ channelType: request.channelType, message: messageOf(err) }),
    }),
  createThread: (request) =>
    Effect.tryPromise({
      try: () => postForResult(config, request, "/threads", decodeThread, "thread"),
      catch: (err) =>
        new ThreadCreateFailed({ channelType: request.channelType, message: messageOf(err) }),
    }),
});

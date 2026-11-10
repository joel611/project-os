import type { InboundMessage } from "@project-os/contracts";

export type Fetcher = (req: Request) => Promise<Response>;

/** Where a Channel Adapter reaches the Coordinator, and the service token it calls with. */
export interface CoordinatorTarget {
  readonly url: string;
  /** COORDINATOR_SERVICE_TOKEN: only Channel Adapters may post messages, commands and clicks. */
  readonly token: string;
}

/** POSTs `body` as JSON to `path` on the Coordinator, as a Channel Adapter. */
export const postToCoordinator = (
  coordinator: CoordinatorTarget,
  path: string,
  body: unknown,
  fetcher: Fetcher,
): Promise<Response> =>
  fetcher(
    new Request(`${coordinator.url.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${coordinator.token}`,
      },
      body: JSON.stringify(body),
    }),
  );

/** POSTs a normalized message to the Coordinator's /inbound endpoint. */
export const forwardInbound = async (
  coordinator: CoordinatorTarget,
  message: InboundMessage,
  fetcher: Fetcher,
): Promise<void> => {
  const res = await postToCoordinator(coordinator, "/inbound", message, fetcher);
  if (!res.ok) throw new Error(`Coordinator /inbound responded ${res.status}`);
};

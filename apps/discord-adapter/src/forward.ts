import type { InboundMessage } from "@project-os/contracts";

type Fetcher = (req: Request) => Promise<Response>;

/** POSTs a normalized message to the Coordinator's /inbound endpoint. */
export const forwardInbound = async (
  coordinatorUrl: string,
  message: InboundMessage,
  fetcher: Fetcher = fetch,
): Promise<void> => {
  const url = `${coordinatorUrl.replace(/\/+$/, "")}/inbound`;
  const res = await fetcher(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    }),
  );
  if (!res.ok) throw new Error(`Coordinator /inbound responded ${res.status}`);
};

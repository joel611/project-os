import type { WorkerRegisterResponse } from "@project-os/contracts";
import type { WatcherCredentials } from "./credentials.ts";

/** Trades a /register-worker code for this computer's credentials. */
export const registerDevice = async (
  input: {
    readonly server: string;
    readonly token: string;
    readonly name?: string;
    readonly hostname?: string;
  },
  fetcher: typeof fetch,
): Promise<WatcherCredentials> => {
  const server = input.server.replace(/\/+$/, "");
  const res = await fetcher(`${server}/workers/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: input.token,
      ...(input.name && { name: input.name }),
      ...(input.hostname && { hostname: input.hostname }),
    }),
  });
  if (res.status === 401) {
    throw new Error("That code is unknown, expired, or already used. Run /register-worker again.");
  }
  if (!res.ok) throw new Error(`Registration failed: HTTP ${res.status}`);
  const body = (await res.json()) as WorkerRegisterResponse;
  return { server, workerId: body.workerId, name: body.name, secret: body.secret };
};

import { BoatApi, Configuration, waitUntilReady } from "@boatdev/sdk";
import { type BoatSize, makeBoatRunner } from "./runner.ts";

export { BOAT_SIZES, makeBoatRunner, POLL_MS, type BoatLike, type BoatSize } from "./runner.ts";

export const DEFAULT_BOAT_API_URL = "https://boat.dev/api/v1";

/** boat.dev's `SandboxRunner` for the sandbox pool (`boat_pi`). */
export const boatSandboxRunner = (options: {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly size?: BoatSize;
}) => {
  const api = new BoatApi(
    new Configuration({
      basePath: options.apiUrl ?? DEFAULT_BOAT_API_URL,
      accessToken: options.apiKey,
    }),
  );
  return makeBoatRunner(
    {
      create: (params) => api.create(params),
      waitUntilReady: (sandboxId) => waitUntilReady(api, sandboxId),
      startCommand: async (sandboxId, command) => {
        const started = await api.command({ sandboxId, command, detached: true });
        if (!("processId" in started))
          throw new Error("boat.dev ran the command inline, not detached");
        return { processId: started.processId };
      },
      commandStatus: (sandboxId, processId) => api.commandStatus({ sandboxId, processId }),
      deleteSandbox: (sandboxId) =>
        api.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId }),
    },
    {
      ...(options.size === undefined ? {} : { size: options.size }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    },
  );
};

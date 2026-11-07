import { Daytona } from "@daytona/sdk";
import { makeSandboxRunner } from "./sdk.ts";

export { makeSandboxRunner } from "./sdk.ts";

/** Daytona's `SandboxRunner` for the sandbox pool (`daytona_pi`). */
export const daytonaSandboxRunner = (options: {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly snapshot?: string;
}) =>
  makeSandboxRunner(
    new Daytona({
      apiKey: options.apiKey,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    }),
    {
      ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    },
  );

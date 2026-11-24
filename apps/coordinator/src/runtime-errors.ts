import { auditRuntimeError } from "@project-os/core";
import type { RuntimeErrorSource } from "@project-os/contracts";
import { Effect } from "effect";
import type { UnhandledRouteError } from "./app.ts";

/** Environment values that must never reach the audit log, whatever an error message says. */
export const runtimeErrorSecrets = (env: Record<string, string | undefined>): string[] =>
  [env.BETTER_AUTH_SECRET, env.COORDINATOR_SERVICE_TOKEN, env.ADMIN_MCP_TOKEN].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );

/**
 * Writes errors to the audit log as `runtime_error` rows. `run` is the entry file's runtime and
 * `keepAlive` holds a promise open past the response (`waitUntil` on Workers). Logging failures
 * are dropped: the error is still on the console.
 */
export const makeRuntimeErrorLogger = <R>(options: {
  readonly run: (effect: Effect.Effect<unknown, never, R>) => Promise<unknown>;
  readonly secrets: ReadonlyArray<string>;
  readonly keepAlive?: (work: Promise<unknown>) => void;
  readonly log?: (message: string, error: unknown) => void;
}) => {
  const log = options.log ?? console.error;
  const record = (source: RuntimeErrorSource, where: string, error: unknown) => {
    log(`${source} error in ${where}`, error);
    const work = options
      .run(
        auditRuntimeError({ source, where, error, secrets: options.secrets }) as Effect.Effect<
          unknown,
          never,
          R
        >,
      )
      .catch(() => undefined);
    options.keepAlive?.(work);
    return work;
  };
  return {
    /** For `createApp`'s `onUnhandledError`. */
    route: ({ where, error }: UnhandledRouteError) => {
      void record("http", where, error);
    },
    /** For a Cron job's `.catch`: logs it and resolves. */
    job: (source: Exclude<RuntimeErrorSource, "http">, where: string) => (error: unknown) =>
      record(source, where, error).then(() => undefined),
  };
};

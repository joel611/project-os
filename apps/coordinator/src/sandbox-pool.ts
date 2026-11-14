import type { SandboxProvider } from "@project-os/contracts";
import type { WorkerLauncher } from "@project-os/core";
import { BOAT_SIZES, type BoatSize, boatSandboxRunner } from "@project-os/sandbox-boat";
import { cloudflareSandboxRunnerLive } from "@project-os/sandbox-cloudflare";
import { daytonaSandboxRunner } from "@project-os/sandbox-daytona";
import { makeSandboxLauncher, resolvePool, type SandboxRunner } from "@project-os/sandbox-core";

type Env = Readonly<Record<string, string | undefined>>;

const nonEmpty = (env: Env, key: string) => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

const required = (env: Env, ...keys: ReadonlyArray<string>) => {
  for (const key of keys) {
    const value = nonEmpty(env, key);
    if (value !== undefined) return value;
  }
  throw new Error(`Missing env var ${keys[0]}`);
};

const positiveInt = (env: Env, key: string) => {
  const raw = nonEmpty(env, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${key} must be a whole number above 0`);
  return n;
};

export const configuredRunners = (
  env: Env,
  live: {
    readonly daytona: typeof daytonaSandboxRunner;
    readonly cloudflare: typeof cloudflareSandboxRunnerLive;
    readonly boat: typeof boatSandboxRunner;
  } = {
    daytona: daytonaSandboxRunner,
    cloudflare: cloudflareSandboxRunnerLive,
    boat: boatSandboxRunner,
  },
): Partial<Record<SandboxProvider, SandboxRunner>> => {
  const daytonaKey = nonEmpty(env, "DAYTONA_API_KEY");
  const cloudflareUrl = nonEmpty(env, "CLOUDFLARE_SANDBOX_URL");
  const apiUrl = nonEmpty(env, "DAYTONA_API_URL");
  const snapshot = nonEmpty(env, "DAYTONA_SNAPSHOT");
  const boatKey = nonEmpty(env, "BOAT_API_KEY");
  const boatUrl = nonEmpty(env, "BOAT_API_URL");
  const boatSize = nonEmpty(env, "BOAT_SANDBOX_SIZE");
  if (boatSize !== undefined && !(BOAT_SIZES as ReadonlyArray<string>).includes(boatSize)) {
    throw new Error(`BOAT_SANDBOX_SIZE must be one of ${BOAT_SIZES.join(", ")}`);
  }
  return {
    ...(daytonaKey && {
      daytona: live.daytona({
        apiKey: daytonaKey,
        ...(apiUrl && { apiUrl }),
        ...(snapshot && { snapshot }),
      }),
    }),
    ...(cloudflareUrl && {
      cloudflare: live.cloudflare({
        url: cloudflareUrl,
        token: required(env, "CLOUDFLARE_SANDBOX_TOKEN"),
      }),
    }),
    ...(boatKey && {
      boat: live.boat({
        apiKey: boatKey,
        ...(boatUrl && { apiUrl: boatUrl }),
        ...(boatSize && { size: boatSize as BoatSize }),
      }),
    }),
  };
};

/**
 * The Coordinator's sandbox pool from env: WORKER_PROVIDERS (comma list, preference order;
 * default every configured provider, Daytona first) and the shared Pi session settings.
 * Undefined when the pool is empty: tickets then wait for a registered device.
 */
export const sandboxLauncherFromEnv = (
  env: Env,
  options: {
    readonly log: (message: string) => void;
    readonly runners?: Partial<Record<SandboxProvider, SandboxRunner>>;
  },
): typeof WorkerLauncher.Service | undefined => {
  const providers = resolvePool({
    requested: env.WORKER_PROVIDERS,
    configured: options.runners ?? configuredRunners(env),
    maxConcurrent: Object.fromEntries(
      Object.entries({
        daytona: positiveInt(env, "DAYTONA_MAX_CONCURRENT"),
        cloudflare: positiveInt(env, "CLOUDFLARE_SANDBOX_MAX_CONCURRENT"),
        boat: positiveInt(env, "BOAT_MAX_CONCURRENT"),
      }).filter((entry): entry is [string, number] => entry[1] !== undefined),
    ),
  });
  if (providers.length === 0) return undefined;
  // Pi's --model takes provider/model, the same string as DEFAULT_MODEL.
  const model = required(env, "SANDBOX_PI_MODEL", "DAYTONA_PI_MODEL", "DEFAULT_MODEL");
  const timeout =
    positiveInt(env, "SANDBOX_SESSION_TIMEOUT_SECONDS") ??
    positiveInt(env, "DAYTONA_SESSION_TIMEOUT_SECONDS");
  options.log(`sandbox pool: ${providers.map((p) => p.workerType).join(", ")}`);
  return makeSandboxLauncher({
    providers,
    mcpUrl: required(env, "SANDBOX_MCP_URL", "DAYTONA_MCP_URL"),
    openrouterApiKey: required(env, "OPENROUTER_API_KEY"),
    model,
    ...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
    log: options.log,
  });
};

import { envBool, envNumber, healthConfig } from "@project-os/config";
import type { Effect } from "effect";
import { type AppDeps, parseOrigins } from "./app.ts";
import type { HttpDeps, HttpEnv } from "./http/routes.ts";
import type { McpServices } from "./mcp/tools.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface CoordinatorConfigInput {
  readonly env: Env;
  /** Runs every effect the routes need against the entry file's runtime. */
  readonly run: <A>(effect: Effect.Effect<A, never, HttpEnv | McpServices>) => Promise<A>;
  /** The Coordinator's public URL; read when a command needs it, so it may be known late. */
  readonly publicUrl: () => string;
  readonly admin: NonNullable<HttpDeps["commands"]>["admin"];
  /** Settings that replace the ones env gives for `inbound` (a test stack, or what the entry file found). */
  readonly inbound?: NonNullable<HttpDeps["inbound"]>;
}

/** `ADMIN_USER_IDS`: comma-separated Discord user ids, whitespace and empties ignored. */
export const parseAdminUserIds = (raw: string | undefined): ReadonlyArray<string> =>
  (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

/**
 * The settings every entry file shares, from env: HTTP ingress and commands, asset routes and
 * CORS. Entry files add what is theirs (access, MCP runtime, auth, connect) and pick the Layers.
 */
export const coordinatorConfig = (
  input: CoordinatorConfigInput,
): Required<Pick<AppDeps, "http" | "assets" | "corsOrigins">> => {
  const { env, run, publicUrl, admin } = input;
  const health = healthConfig();
  const adminChannelId = env.ADMIN_CHANNEL_ID;
  const adminUserIds = parseAdminUserIds(env.ADMIN_USER_IDS);
  const [dashboardUrl] = parseOrigins(env.WEB_ORIGIN);
  return {
    http: {
      run,
      inbound: {
        confidenceThreshold: envNumber("INTENT_CONFIDENCE_THRESHOLD", 0.5, env),
        requireMention: envBool("DISCORD_REQUIRE_MENTION", true, env),
        workerStaleMs: health.workerStaleMs,
        sharedWorkerMaxTickets: health.sharedWorkerMaxTickets,
        ...(adminChannelId && { adminChannelId, adminUserIds }),
        ...input.inbound,
      },
      commands: {
        ...(adminChannelId && { adminChannelId, adminUserIds }),
        admin,
        ...(dashboardUrl && { dashboardUrl }),
        connections: run,
        sources: run,
        workers: {
          run,
          get publicUrl() {
            return publicUrl();
          },
          ...(env.WATCHER_INSTALL_COMMAND && { installCommand: env.WATCHER_INSTALL_COMMAND }),
          staleMs: health.workerStaleMs,
        },
      },
    },
    assets: { run },
    corsOrigins: parseOrigins(env.WEB_ORIGIN),
  };
};

import type { SandboxRunner } from "@project-os/sandbox-core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { configuredRunners, sandboxEgressUrl, sandboxLauncherFromEnv } from "./sandbox-pool.ts";

const runner = (): SandboxRunner => ({ run: async () => ({ exitCode: 0, output: "" }) });
const base = {
  SANDBOX_MCP_URL: "https://tunnel.example/mcp",
  OPENROUTER_API_KEY: "sk-or",
  DEFAULT_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
};
const launcher = (
  env: Record<string, string>,
  runners = { daytona: runner(), cloudflare: runner() },
) => sandboxLauncherFromEnv({ ...base, ...env }, { log: () => {}, runners });
const pool = (l: ReturnType<typeof launcher>) => Effect.runPromise(l!.pool);

describe("sandbox pool from env", () => {
  it("is off with no provider configured", () => {
    expect(sandboxLauncherFromEnv(base, { log: () => {} })).toBeUndefined();
  });

  it("passes the end-of-session hook to the launcher", async () => {
    const ended: string[] = [];
    const l = sandboxLauncherFromEnv(base, {
      log: () => {},
      runners: { daytona: runner() },
      onSessionEnd: (session) => void ended.push(session.workerId),
    });
    await Effect.runPromise(
      l!.launch({
        ticketId: "t1",
        workerType: "daytona_pi",
        workerId: "daytona-t1",
        mcpToken: "tok",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(ended).toEqual(["daytona-t1"]);
  });

  it("builds the real runners from credentials and takes a session timeout", async () => {
    const logs: string[] = [];
    const l = sandboxLauncherFromEnv(
      {
        ...base,
        DAYTONA_API_KEY: "d",
        DAYTONA_API_URL: "https://daytona.example/api",
        DAYTONA_SNAPSHOT: "snap",
        CLOUDFLARE_SANDBOX_URL: "https://bridge.example",
        CLOUDFLARE_SANDBOX_TOKEN: "t",
        SANDBOX_SESSION_TIMEOUT_SECONDS: "60",
      },
      { log: (m) => logs.push(m) },
    );
    expect(await pool(l)).toEqual([
      { workerType: "daytona_pi", sessionTimeoutSeconds: 60 },
      { workerType: "cloudflare_pi", sessionTimeoutSeconds: 60 },
    ]);
    expect(logs).toEqual(["sandbox pool: daytona_pi, cloudflare_pi"]);
  });

  it("hands sandboxes the credential proxy beside MCP when it's on", async () => {
    const envs: Array<Readonly<Record<string, string>>> = [];
    const logs: string[] = [];
    const l = sandboxLauncherFromEnv(
      { ...base, SANDBOX_CREDENTIAL_PROXY: "1" },
      {
        log: (m) => logs.push(m),
        runners: {
          daytona: {
            run: async ({ env }) => {
              envs.push(env);
              return { exitCode: 0, output: "" };
            },
          },
        },
      },
    );
    await Effect.runPromise(
      l!.launch({
        ticketId: "t1",
        workerType: "daytona_pi",
        workerId: "daytona-t1",
        mcpToken: "m",
      }),
    );
    expect(envs[0]).toMatchObject({ PROJECT_OS_EGRESS_URL: "https://tunnel.example/egress" });
    expect(logs).toContain("credential proxy on: sandboxes call https://tunnel.example/egress");
  });

  it("derives the proxy URL from the MCP URL unless SANDBOX_EGRESS_URL says", () => {
    expect(sandboxEgressUrl({}, "https://c.example/base/mcp/")).toBe(
      "https://c.example/base/egress",
    );
    expect(sandboxEgressUrl({ SANDBOX_EGRESS_URL: "https://p.example/e" }, "https://c/x")).toBe(
      "https://p.example/e",
    );
    expect(() => sandboxEgressUrl({}, "https://c.example/rpc")).toThrow("SANDBOX_EGRESS_URL");
  });

  it("needs a Pi model when there's no default model to borrow", () => {
    expect(() =>
      sandboxLauncherFromEnv(
        { SANDBOX_MCP_URL: "https://t/mcp", OPENROUTER_API_KEY: "k" },
        { log: () => {}, runners: { daytona: runner() } },
      ),
    ).toThrow("Missing env var SANDBOX_PI_MODEL");
  });

  it("orders the pool by WORKER_PROVIDERS, with per-provider caps", async () => {
    expect(
      await pool(
        launcher({
          WORKER_PROVIDERS: "cloudflare,daytona",
          CLOUDFLARE_SANDBOX_MAX_CONCURRENT: "2",
        }),
      ),
    ).toEqual([
      { workerType: "cloudflare_pi", maxConcurrent: 2, sessionTimeoutSeconds: 1800 },
      { workerType: "daytona_pi", sessionTimeoutSeconds: 1800 },
    ]);
  });

  it("refuses a cap that isn't a whole number above 0", () => {
    expect(() => launcher({ DAYTONA_MAX_CONCURRENT: "0" })).toThrow(/DAYTONA_MAX_CONCURRENT/);
  });

  it("still reads the Daytona-only names from before the pool", async () => {
    const env = {
      OPENROUTER_API_KEY: "k",
      DAYTONA_MCP_URL: "https://t/mcp",
      DAYTONA_PI_MODEL: "m",
    };
    const l = sandboxLauncherFromEnv(env, {
      log: () => {},
      runners: { daytona: runner() },
    });
    expect(await pool(l)).toEqual([{ workerType: "daytona_pi", sessionTimeoutSeconds: 1800 }]);
  });

  it("needs a public MCP URL once a provider is in the pool", () => {
    expect(() =>
      sandboxLauncherFromEnv(
        { OPENROUTER_API_KEY: "k", DEFAULT_MODEL: "openrouter/m" },
        { log: () => {}, runners: { daytona: runner() } },
      ),
    ).toThrow("Missing env var SANDBOX_MCP_URL");
  });
});

describe("configured runners", () => {
  const live = {
    daytona: (o: unknown) => ({ ...runner(), o }) as unknown as SandboxRunner,
    cloudflare: (o: unknown) => ({ ...runner(), o }) as unknown as SandboxRunner,
    boat: (o: unknown) => ({ ...runner(), o }) as unknown as SandboxRunner,
  };

  it("builds a runner per provider whose credentials are set", () => {
    expect(Object.keys(configuredRunners({}, live))).toEqual([]);
    const both = configuredRunners(
      {
        DAYTONA_API_KEY: "d",
        CLOUDFLARE_SANDBOX_URL: "https://bridge.example",
        CLOUDFLARE_SANDBOX_TOKEN: "t",
      },
      live,
    );
    expect(Object.keys(both)).toEqual(["daytona", "cloudflare"]);
    expect((both["cloudflare"] as unknown as { o: unknown }).o).toEqual({
      url: "https://bridge.example",
      token: "t",
    });
  });

  it("builds boat.dev from its API key, with optional URL and size", () => {
    const boat = configuredRunners(
      {
        BOAT_API_KEY: "boat_k",
        BOAT_API_URL: "https://boat.example/api/v1",
        BOAT_SANDBOX_SIZE: "small",
      },
      live,
    )["boat"] as unknown as { o: unknown };
    expect(boat.o).toEqual({
      apiKey: "boat_k",
      apiUrl: "https://boat.example/api/v1",
      size: "small",
    });
    expect(Object.keys(configuredRunners({ BOAT_API_KEY: "k" }, live))).toEqual(["boat"]);
  });

  it("refuses an unknown boat.dev size", () => {
    expect(() => configuredRunners({ BOAT_API_KEY: "k", BOAT_SANDBOX_SIZE: "huge" }, live)).toThrow(
      /BOAT_SANDBOX_SIZE must be one of/,
    );
  });

  it("needs the bridge token with the bridge URL", () => {
    expect(() => configuredRunners({ CLOUDFLARE_SANDBOX_URL: "https://b" }, live)).toThrow(
      "Missing env var CLOUDFLARE_SANDBOX_TOKEN",
    );
  });
});

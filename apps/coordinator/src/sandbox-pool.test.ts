import type { SandboxRunner } from "@project-os/infra-sandbox";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { configuredRunners, sandboxLauncherFromEnv } from "./sandbox-pool.ts";

const runner = (): SandboxRunner => ({ run: async () => ({ exitCode: 0, output: "" }) });
const base = {
  SANDBOX_MCP_URL: "https://tunnel.example/mcp",
  OPENROUTER_API_KEY: "sk-or",
  CHAT_MODEL_ID: "anthropic/claude-sonnet-4.5",
};
const launcher = (
  env: Record<string, string>,
  runners = { daytona: runner(), cloudflare: runner() },
) => sandboxLauncherFromEnv({ ...base, ...env }, { prompt: "p", log: () => {}, runners });
const pool = (l: ReturnType<typeof launcher>) => Effect.runPromise(l!.pool);

describe("sandbox pool from env", () => {
  it("is off with no provider configured", () => {
    expect(sandboxLauncherFromEnv(base, { prompt: "p", log: () => {} })).toBeUndefined();
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
      { prompt: "p", log: (m) => logs.push(m) },
    );
    expect(await pool(l)).toEqual([{ workerType: "daytona_pi" }, { workerType: "cloudflare_pi" }]);
    expect(logs).toEqual(["sandbox pool: daytona_pi, cloudflare_pi"]);
  });

  it("needs a Pi model when there's no chat model to borrow", () => {
    expect(() =>
      sandboxLauncherFromEnv(
        { SANDBOX_MCP_URL: "https://t/mcp", OPENROUTER_API_KEY: "k" },
        { prompt: "p", log: () => {}, runners: { daytona: runner() } },
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
    ).toEqual([{ workerType: "cloudflare_pi", maxConcurrent: 2 }, { workerType: "daytona_pi" }]);
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
      prompt: "p",
      log: () => {},
      runners: { daytona: runner() },
    });
    expect(await pool(l)).toEqual([{ workerType: "daytona_pi" }]);
  });

  it("needs a public MCP URL once a provider is in the pool", () => {
    expect(() =>
      sandboxLauncherFromEnv(
        { OPENROUTER_API_KEY: "k", CHAT_MODEL_ID: "m" },
        { prompt: "p", log: () => {}, runners: { daytona: runner() } },
      ),
    ).toThrow("Missing env var SANDBOX_MCP_URL");
  });
});

describe("configured runners", () => {
  const live = {
    daytona: (o: unknown) => ({ ...runner(), o }) as unknown as SandboxRunner,
    cloudflare: (o: unknown) => ({ ...runner(), o }) as unknown as SandboxRunner,
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
    expect((both.cloudflare as unknown as { o: unknown }).o).toEqual({
      url: "https://bridge.example",
      token: "t",
    });
  });

  it("needs the bridge token with the bridge URL", () => {
    expect(() => configuredRunners({ CLOUDFLARE_SANDBOX_URL: "https://b" }, live)).toThrow(
      "Missing env var CLOUDFLARE_SANDBOX_TOKEN",
    );
  });
});

import { describe, expect, it } from "vite-plus/test";
import type { SandboxRunner } from "./launcher.ts";
import { resolvePool } from "./pool.ts";

const runner = (): SandboxRunner => ({ run: async () => ({ exitCode: 0, output: "" }) });
const daytona = runner();
const cloudflare = runner();
const types = (pool: ReturnType<typeof resolvePool>) => pool.map((p) => p.workerType);

describe("resolvePool", () => {
  it("is empty with nothing configured or requested", () => {
    expect(resolvePool({ requested: undefined, configured: {} })).toEqual([]);
  });

  it("defaults to every configured provider, Daytona first", () => {
    const pool = resolvePool({ requested: " ", configured: { cloudflare, daytona } });
    expect(types(pool)).toEqual(["daytona_pi", "cloudflare_pi"]);
    expect(pool[0]!.runner).toBe(daytona);
  });

  it("follows WORKER_PROVIDERS order, ignoring case, blanks and repeats", () => {
    const pool = resolvePool({
      requested: "Cloudflare, ,daytona,cloudflare",
      configured: { cloudflare, daytona },
    });
    expect(types(pool)).toEqual(["cloudflare_pi", "daytona_pi"]);
  });

  it("leaves out configured providers WORKER_PROVIDERS doesn't name", () => {
    const pool = resolvePool({ requested: "cloudflare", configured: { cloudflare, daytona } });
    expect(types(pool)).toEqual(["cloudflare_pi"]);
  });

  it("attaches per-provider caps", () => {
    const pool = resolvePool({
      requested: undefined,
      configured: { daytona },
      maxConcurrent: { daytona: 2 },
    });
    expect(pool).toEqual([{ workerType: "daytona_pi", runner: daytona, maxConcurrent: 2 }]);
  });

  it("refuses a named provider that isn't configured", () => {
    expect(() => resolvePool({ requested: "cloudflare", configured: { daytona } })).toThrow(
      /names "cloudflare" but it isn't configured/,
    );
  });

  it("refuses an unknown provider", () => {
    expect(() => resolvePool({ requested: "e2b", configured: {} })).toThrow(
      /unknown provider "e2b"/,
    );
  });

  it("builds boat.dev as boat_pi", () => {
    const boat = runner();
    expect(types(resolvePool({ requested: "boat", configured: { boat } }))).toEqual(["boat_pi"]);
  });
});

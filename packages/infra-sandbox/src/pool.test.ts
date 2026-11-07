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
    const pool = resolvePool({
      requested: " ",
      configured: { "sandbox-cloudflare": cloudflare, "sandbox-daytona": daytona },
    });
    expect(types(pool)).toEqual(["daytona_pi", "cloudflare_pi"]);
    expect(pool[0]!.runner).toBe(daytona);
  });

  it("follows WORKER_PROVIDERS order, ignoring case, blanks and repeats", () => {
    const pool = resolvePool({
      requested: "Sandbox-Cloudflare, ,sandbox-daytona,sandbox-cloudflare",
      configured: { "sandbox-cloudflare": cloudflare, "sandbox-daytona": daytona },
    });
    expect(types(pool)).toEqual(["cloudflare_pi", "daytona_pi"]);
  });

  it("leaves out configured providers WORKER_PROVIDERS doesn't name", () => {
    const pool = resolvePool({
      requested: "sandbox-cloudflare",
      configured: { "sandbox-cloudflare": cloudflare, "sandbox-daytona": daytona },
    });
    expect(types(pool)).toEqual(["cloudflare_pi"]);
  });

  it("attaches per-provider caps", () => {
    const pool = resolvePool({
      requested: undefined,
      configured: { "sandbox-daytona": daytona },
      maxConcurrent: { "sandbox-daytona": 2 },
    });
    expect(pool).toEqual([{ workerType: "daytona_pi", runner: daytona, maxConcurrent: 2 }]);
  });

  it("refuses a named provider that isn't configured", () => {
    expect(() =>
      resolvePool({ requested: "sandbox-cloudflare", configured: { "sandbox-daytona": daytona } }),
    ).toThrow(/names "sandbox-cloudflare" but it isn't configured/);
  });

  it("refuses an unknown provider, including the bare name without the prefix", () => {
    expect(() => resolvePool({ requested: "e2b", configured: {} })).toThrow(
      /unknown provider "e2b"/,
    );
    expect(() => resolvePool({ requested: "daytona", configured: {} })).toThrow(
      /unknown provider "daytona" \(known: sandbox-daytona, sandbox-cloudflare, sandbox-boat\)/,
    );
  });

  it("builds boat.dev as boat_pi", () => {
    const boat = runner();
    expect(
      types(resolvePool({ requested: "sandbox-boat", configured: { "sandbox-boat": boat } })),
    ).toEqual(["boat_pi"]);
  });
});

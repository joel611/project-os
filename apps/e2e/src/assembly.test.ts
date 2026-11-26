// The Coordinator assembly's own interface: the jobs it hands a platform, how they run on a
// timer or a Cron Trigger, and the work a Worker must hold open. The HTTP and MCP app it builds
// is what every other suite drives.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, SkillSource, TicketRepository, WorkerLauncher } from "@project-os/core";
import { DrizzleBun, ensureOrg, LocalLive } from "@project-os/infra-local";
import {
  AgentRuntimeEcho,
  classifierReturning,
  makeChannelDigesterRecording,
  makeEmailClassifierFake,
  makeSidekickRecording,
} from "@project-os/testing";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { assembleCoordinator, type CoordinatorAdapters } from "../../coordinator/src/assembly.ts";

interface Scheduled {
  readonly name: string;
  readonly everyMs: number;
  readonly task: Effect.Effect<void>;
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const assemble = (
  options: {
    readonly env?: Record<string, string>;
    /** `undefined` is a first Cloudflare deploy, before PUBLIC_URL is known. */
    readonly publicUrl?: string | undefined;
    /** Replaces the ticket repository with one whose every list fails. */
    readonly brokenTickets?: boolean;
    readonly waitUntil?: CoordinatorAdapters["waitUntil"];
  } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "assembly-"));
  const dbPath = join(dir, "project-os.sqlite");
  ensureOrg(dbPath, { id: "o1", name: "Org" });
  const scheduled: Scheduled[] = [];
  const stopped: string[] = [];
  const coordinator = assembleCoordinator({
    env: {
      COORDINATOR_SERVICE_TOKEN: "service-token",
      BETTER_AUTH_SECRET: "assembly-secret-assembly-secret",
      ...options.env,
    },
    publicUrl: "publicUrl" in options ? options.publicUrl : "http://localhost:1",
    orgId: "o1",
    database: DrizzleBun(dbPath),
    platform: ({ skillSource, workerLauncher }) =>
      Layer.mergeAll(
        LocalLive({
          dbPath,
          adapterUrls: {},
          skillSource,
          ...(workerLauncher && { workerLauncher }),
        }),
        // A timer the test fires by hand.
        Layer.succeed(Scheduler, {
          every: (name, everyMs, task) =>
            Effect.sync(() => {
              scheduled.push({ name, everyMs, task });
              return Effect.sync(() => void stopped.push(name));
            }),
        }),
        ...(options.brokenTickets
          ? [
              Layer.succeed(TicketRepository, {
                listByStatus: () => Effect.die(new Error("database gone")),
              } as never),
            ]
          : []),
      ),
    ai: () =>
      Layer.mergeAll(
        classifierReturning("new_request"),
        AgentRuntimeEcho,
        makeSidekickRecording().layer,
        makeChannelDigesterRecording().layer,
        makeEmailClassifierFake().layer,
      ),
    ...(options.waitUntil && { waitUntil: options.waitUntil }),
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => coordinator.dispose(),
  );
  return { coordinator, scheduled, stopped };
};

const names = (list: ReadonlyArray<{ readonly name: string }>) => list.map((job) => job.name);

describe("Coordinator assembly: before the public URL is known", () => {
  it("serves, with account linking off", async () => {
    const { coordinator } = assemble({ publicUrl: undefined });
    const health = await coordinator.app.handle(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(coordinator.auth.connections).toBeUndefined();
  });
});

describe("Coordinator assembly: outside providers", () => {
  it("reads skills from the real API unless a test says otherwise", async () => {
    const asked: string[] = [];
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string) => {
      asked.push(input);
      return new Response("missing", { status: 404 });
    }) as typeof fetch);
    cleanups.push(() => fetched.mockRestore());
    const { coordinator } = assemble();
    await expect(
      coordinator.runtime.runPromise(SkillSource.use((source) => source.list("acme/skills"))),
    ).rejects.toThrow("was not found");
    expect(asked).toEqual(["https://api.github.com/repos/acme/skills"]);
  });
});

describe("Coordinator assembly: recurring jobs", () => {
  it("lists the sweep and the Channel Digest, and the Email Digest only when it is on", () => {
    expect(names(assemble().coordinator.jobs)).toEqual(["health-sweep", "channel-digest"]);
    expect(names(assemble({ env: { EMAIL_DIGEST: "true" } }).coordinator.jobs)).toEqual([
      "health-sweep",
      "channel-digest",
      "email-digest",
    ]);
  });

  it("runs each job once on demand, as a Cron tick does", async () => {
    const { coordinator } = assemble({ env: { EMAIL_DIGEST: "true" } });
    for (const job of coordinator.jobs) await expect(job.run()).resolves.toBeUndefined();
  });

  it("rejects a failed run, so the Cron handler can log it", async () => {
    const { coordinator } = assemble({ brokenTickets: true });
    await expect(coordinator.jobs[0]!.run()).rejects.toThrow("database gone");
  });

  it("schedules every job on the platform's Scheduler at the sweep interval, and stops them", async () => {
    const { coordinator, scheduled, stopped } = assemble({
      env: { EMAIL_DIGEST: "true", HEALTH_SWEEP_EVERY_SEC: "5" },
    });
    const stop = await coordinator.startJobs();
    expect(scheduled.map(({ name, everyMs }) => [name, everyMs])).toEqual([
      ["health-sweep", 5000],
      ["channel-digest", 5000],
      ["email-digest", 5000],
    ]);
    for (const { task } of scheduled) await Effect.runPromise(task);
    await stop();
    expect(stopped).toEqual(["health-sweep", "channel-digest", "email-digest"]);
  });

  it("logs a failed scheduled run instead of failing the timer", async () => {
    // Effect's default logger writes here.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => log.mockRestore());
    const { coordinator, scheduled } = assemble({ brokenTickets: true });
    await coordinator.startJobs();
    await expect(Effect.runPromise(scheduled[0]!.task)).resolves.toBeUndefined();
    expect(log.mock.calls.flat().join(" ")).toContain("health sweep failed");
  });
});

describe("Coordinator assembly: a platform that needs work held open", () => {
  it("holds a sandbox session and its run log open with waitUntil", async () => {
    const bridge = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 503 }) });
    cleanups.push(() => bridge.stop(true));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => log.mockRestore());
    const held: Array<Promise<unknown>> = [];
    const { coordinator } = assemble({
      // So that keeping the run log fails: what is held open must still not reject.
      brokenTickets: true,
      env: {
        CLOUDFLARE_SANDBOX_URL: `http://localhost:${bridge.port}`,
        CLOUDFLARE_SANDBOX_TOKEN: "bridge-token",
        SANDBOX_MCP_URL: "http://localhost:1/mcp",
        SANDBOX_PI_MODEL: "openrouter/some/model",
        OPENROUTER_API_KEY: "key",
      },
      waitUntil: (promise) => void held.push(promise),
    });

    await coordinator.runtime.runPromise(
      WorkerLauncher.use((launcher) =>
        launcher.launch({
          ticketId: "t1",
          workerType: "cloudflare_pi",
          workerId: "cloudflare-t1",
          mcpToken: "mcp-token",
        }),
      ),
    );
    // The session first; its run log once the session has ended.
    expect(held).toHaveLength(1);
    await held[0];
    await vi.waitFor(() => expect(held).toHaveLength(2));
    await expect(held[1]).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(log.mock.calls.flat().join(" ")).toContain("cloudflare-t1 run log not kept"),
    );
  });
});

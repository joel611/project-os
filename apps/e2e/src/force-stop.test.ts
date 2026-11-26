import { Database } from "bun:sqlite";
import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { expect, it } from "vite-plus/test";
import { fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { loadConfig } from "../../watcher/src/config.ts";
import { silentLogger } from "../../watcher/src/logger.ts";
import { httpMcpClient } from "../../watcher/src/mcp-client.ts";
import { createWatcher } from "../../watcher/src/poll.ts";
import { bunSpawner, type SpawnAcp } from "../../watcher/src/spawn.ts";
import { SERVICE_TOKEN, startStack } from "./stack.ts";

it.each(["admin", "Discord"])(
  "kills the running Watcher process and holds the ticket until %s resumes it",
  async (resume) => {
    const stack = await startStack({
      classifier: Layer.succeed(IntentClassifier, {
        classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
      }),
    });
    let killChild: (() => void) | undefined;
    try {
      const worker = await stack.registerSharedWorker();
      const channelId = "work";
      const projectId = await stack.linkChannel(channelId);
      const ada = { channelId, userId: "ada", name: "Ada" };
      await forwardInbound(stack.coordinator, fakeInbound(ada, "Please check the build")!, fetch);
      const [{ id: ticketId }] = await stack.json("GET", `/projects/${projectId}/tickets`);
      const path = `/tickets/${ticketId}`;
      const ticket = () => stack.json("GET", path);
      const config = {
        ...loadConfig(
          { server: stack.url, workerId: worker.workerId, secret: worker.secret, name: "test" },
          () => false,
        ),
        agent: "pi" as const,
        piAcp: resume === "Discord",
      };
      const client = httpMcpClient(config.mcpUrl, fetch, worker.secret, silentLogger);
      const claim = () => client.callTool("ticket_claim", { ticketId, workerId: worker.workerId });
      const auth = (secret: string) => ({ authorization: `Bearer ${secret}` });
      const runId = "active-run";
      const runPath = `${path}/runs/${runId}`;
      let exit: number | undefined;
      let launches = 0;
      const spawnChild = (options: Parameters<SpawnAcp>[1]) => {
        launches++;
        const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
          ...options,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        killChild = () => proc.kill("SIGKILL");
        void proc.exited.then((code) => {
          exit = code;
          killChild = undefined;
        });
        return {
          exited: proc.exited,
          stdout: proc.stdout,
          stderr: proc.stderr,
          stdin: new WritableStream<Uint8Array>({ write: (data) => void proc.stdin.write(data) }),
          kill: (signal?: "SIGKILL") => {
            if (exit === undefined) proc.kill(signal);
          },
        };
      };
      const spawner = bunSpawner(config, (_cmd, options) => spawnChild(options), {
        spawnAcp: (_cmd, options) => spawnChild(options),
        readFile: () => undefined,
        writePrivate: () => {},
        env: process.env,
        configDir: "/unused",
        home: "/unused",
        logger: silentLogger,
        fetchStop: async (url, secret, signal) => {
          const res = await fetch(url, { headers: auth(secret), signal });
          return res.ok && ((await res.json()) as { stop?: boolean }).stop === true;
        },
        runLog: {
          newRunId: () => runId,
          now: () => new Date(),
          flushEveryMs: 20,
          secrets: [],
          sleep: async () => {},
          terminal: { out: () => {}, err: () => {} },
          spool: { write: () => {}, list: () => [], remove: () => {} },
          post: async (url, secret, upload) => {
            const res = await fetch(url, {
              method: "POST",
              headers: { ...auth(secret), "content-type": "application/json" },
              body: JSON.stringify(upload),
            });
            return res.ok
              ? { ok: true, nextSeq: ((await res.json()) as { nextSeq: number }).nextSeq }
              : { ok: false, status: res.status };
          },
        },
      });
      const watcher = createWatcher({ config, client, spawner, logger: silentLogger });
      await watcher.pollOnce();
      const before = (await ticket()).ticket;
      if (resume === "admin") await claim();
      await expect
        .poll(() => stack.json("GET", runPath))
        .toMatchObject({ run: { status: "running", stoppable: true } });
      const other = await stack.registerSharedWorker("spare");
      const signal = (secret: string) =>
        fetch(`${stack.url}${runPath}/signal`, { headers: auth(secret) });
      expect((await signal(other.secret)).status).toBe(404);
      expect((await signal(worker.secret)).status).toBe(200);
      expect(
        (
          await fetch(`${stack.url}${runPath}/stop`, {
            method: "POST",
            headers: auth(SERVICE_TOKEN),
          })
        ).status,
      ).toBe(403);
      expect(await stack.json("POST", `${path}/runs/nonexistent/stop`)).toMatchObject({
        error: "RunNotFound",
      });
      expect(await stack.json("POST", `${path}/status`, { status: "stopped" })).toMatchObject({
        error: "InvalidTransition",
      });
      expect(await stack.json("POST", `${runPath}/stop`)).toMatchObject({ status: "stopped" });
      expect(await (await signal(worker.secret)).json()).toEqual({ stop: true });
      expect(
        await stack.json("POST", `${path}/assign`, { workerId: other.workerId }),
      ).toMatchObject({ error: "InvalidTransition" });
      await expect.poll(() => watcher.running(), { timeout: 4_000 }).toBe(0);
      expect(exit).toBe(137);
      await expect(claim()).rejects.toThrow();
      await watcher.pollOnce();
      expect(launches).toBe(1);
      expect(await ticket()).toMatchObject({
        ticket: { status: "stopped" },
        events: expect.arrayContaining([
          expect.objectContaining({ payload: { kind: "force_stopped", runId } }),
        ]),
      });
      expect(await stack.json("POST", `${runPath}/stop`)).toMatchObject({
        error: "InvalidTransition",
      });
      expect(await stack.json("GET", runPath)).toMatchObject({ run: { status: "stopped" } });

      if (resume === "admin") {
        // Older tickets may predate requester storage; Continue can still use shared placement.
        using db = new Database(stack.dbPath);
        db.query("UPDATE tickets SET requester = NULL WHERE id = ?").run(ticketId);
        expect(await stack.json("POST", `${path}/continue`)).toMatchObject({ status: "assigned" });
      } else {
        await forwardInbound(
          stack.coordinator,
          fakeInbound({ ...ada, threadId: "discord-thread-1" }, "Please continue the build check")!,
          fetch,
        );
      }
      const after = (await ticket()).ticket;
      expect(after).toMatchObject({ status: "assigned", startedAt: null });
      expect(after.assignedAt).not.toBe(before.assignedAt);
      expect(await (await signal(worker.secret)).json()).toEqual({ stop: true });
      expect(await stack.json("POST", `${path}/continue`)).toMatchObject({
        error: "InvalidTransition",
      });
    } finally {
      killChild?.();
      await stack.stop();
    }
  },
  15_000,
);

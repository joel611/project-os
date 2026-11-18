import type { WatcherConfig } from "./config.ts";
import type { Spawner } from "./spawn.ts";
import { createTail } from "./tail.ts";

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface WatcherDeps {
  readonly config: WatcherConfig;
  readonly client: McpClient;
  readonly spawner: Spawner;
  readonly log: (message: string) => void;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const createWatcher = ({ config, client, spawner, log }: WatcherDeps) => {
  let running = 0;

  /** Leaves a trace on the ticket so the dashboard shows how the session ended, not only the agent's own words. */
  const report = async (
    ticketId: string,
    startedAt: number,
    outcome: { exitCode: number } | { error: string },
    tail: string,
  ) => {
    const durationMs = Date.now() - startedAt;
    const ended =
      "exitCode" in outcome ? `exit ${outcome.exitCode}` : `failed to run: ${outcome.error}`;
    try {
      await client.callTool("ticket_append_event", {
        ticketId,
        type: "system",
        actor: "worker",
        actorId: config.workerId,
        body: `Watcher session ended (${ended}, ${Math.round(durationMs / 1000)}s)`,
        payload: { kind: "watcher_session", ...outcome, durationMs, tail },
      });
    } catch (e) {
      log(`session report failed: ${errorMessage(e)}`);
    }
  };

  const start = (ticketId: string | undefined) => {
    running++;
    log(`session start (${running}/${config.maxSessions})`);
    const startedAt = Date.now();
    const tail = createTail([config.secret]);
    const done = (outcome: { exitCode: number } | { error: string }) => {
      running--;
      log(
        `session exit ${"exitCode" in outcome ? `code=${outcome.exitCode}` : `error=${outcome.error}`} (${running}/${config.maxSessions})`,
      );
      if (ticketId) void report(ticketId, startedAt, outcome, tail.read());
    };
    spawner.spawn(tail.push).then(
      (exitCode) => done({ exitCode }),
      (e) => done({ error: errorMessage(e) }),
    );
  };

  const pollOnce = async (): Promise<void> => {
    try {
      await client.callTool("worker_heartbeat", {
        workerId: config.workerId,
        workerType: config.workerType,
      });
      const out = (await client.callTool("ticket_list_assigned", {
        workerId: config.workerId,
        workerType: config.workerType,
      })) as { tickets: readonly { id?: string }[] };
      const spawnable = Math.min(config.maxSessions - running, out.tickets.length);
      for (let i = 0; i < spawnable; i++) start(out.tickets[i]?.id);
    } catch (e) {
      log(`poll failed: ${errorMessage(e)}`);
    }
  };

  return { pollOnce, running: () => running };
};

import type { WatcherConfig } from "./config.ts";
import type { Spawner } from "./spawn.ts";

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface WatcherDeps {
  readonly config: WatcherConfig;
  readonly client: McpClient;
  readonly spawner: Spawner;
  readonly log: (message: string) => void;
}

// The watcher never claims tickets; the spawned agent session does.
export const createWatcher = ({ config, client, spawner, log }: WatcherDeps) => {
  let running = 0;

  const start = () => {
    running++;
    log(`session start (${running}/${config.maxSessions})`);
    const done = (outcome: string) => {
      running--;
      log(`session exit ${outcome} (${running}/${config.maxSessions})`);
    };
    spawner.spawn().then(
      (code) => done(`code=${code}`),
      (e) => done(`error=${e instanceof Error ? e.message : String(e)}`),
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
      })) as { tickets: readonly unknown[] };
      const spawnable = Math.min(config.maxSessions - running, out.tickets.length);
      for (let i = 0; i < spawnable; i++) start();
    } catch (e) {
      log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return { pollOnce, running: () => running };
};

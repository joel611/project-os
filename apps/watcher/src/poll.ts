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

export const createWatcher = ({ config, client, spawner, log }: WatcherDeps) => {
  let running = 0;
  /** Tickets with a session under way, so a slow start isn't launched twice. */
  const inFlight = new Set<string>();

  const start = (ticketId: string) => {
    running++;
    inFlight.add(ticketId);
    log(`session start (${running}/${config.maxSessions}) for ${ticketId}`);
    const done = (outcome: string) => {
      running--;
      inFlight.delete(ticketId);
      log(`session exit ${outcome} (${running}/${config.maxSessions})`);
    };
    spawner.spawn(ticketId).then(
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
      })) as { tickets: ReadonlyArray<{ readonly id: string }> };
      const waiting = out.tickets.filter((t) => !inFlight.has(t.id));
      for (const ticket of waiting.slice(0, Math.max(0, config.maxSessions - running))) {
        start(ticket.id);
      }
    } catch (e) {
      log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return { pollOnce, running: () => running };
};

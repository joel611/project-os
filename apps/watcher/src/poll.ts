import type { WatcherConfig } from "./config.ts";
import { errorMessage, type Logger } from "./logger.ts";
import type { Spawner } from "./spawn.ts";

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface WatcherDeps {
  readonly config: WatcherConfig;
  readonly client: McpClient;
  readonly spawner: Spawner;
  readonly logger: Logger;
}

export const createWatcher = ({ config, client, spawner, logger }: WatcherDeps) => {
  let running = 0;
  /** Tickets with a session under way, so a slow start isn't launched twice. */
  const inFlight = new Set<string>();

  const start = (ticketId: string) => {
    running++;
    inFlight.add(ticketId);
    const startedAt = Date.now();
    logger.info(`session start (${running}/${config.maxSessions}) for ${ticketId}`, { ticketId });
    const done = (outcome: string, failed: boolean) => {
      running--;
      inFlight.delete(ticketId);
      const message = `session exit ${outcome} (${running}/${config.maxSessions})`;
      const fields = { ticketId, seconds: Math.round((Date.now() - startedAt) / 1000) };
      if (failed) logger.warn(message, fields);
      else logger.info(message, fields);
    };
    spawner.spawn(ticketId).then(
      (code) => done(`code=${code}`, code !== 0),
      (e) => done(`error=${errorMessage(e)}`, true),
    );
  };

  const pollOnce = async (): Promise<void> => {
    try {
      logger.debug("poll: heartbeat", { workerId: config.workerId });
      await client.callTool("worker_heartbeat", {
        workerId: config.workerId,
        workerType: config.workerType,
      });
      const out = (await client.callTool("ticket_list_assigned", {
        workerId: config.workerId,
        workerType: config.workerType,
      })) as { tickets: ReadonlyArray<{ readonly id: string }> };
      const waiting = out.tickets.filter((t) => !inFlight.has(t.id));
      logger.debug(`poll: ${out.tickets.length} assigned, ${waiting.length} waiting`, {
        running,
        maxSessions: config.maxSessions,
        ticketIds: out.tickets.map((t) => t.id),
      });
      for (const ticket of waiting.slice(0, Math.max(0, config.maxSessions - running))) {
        start(ticket.id);
      }
    } catch (e) {
      logger.error(`poll failed: ${errorMessage(e)}`);
    }
  };

  return { pollOnce, running: () => running };
};

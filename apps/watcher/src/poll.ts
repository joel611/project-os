import { ticketPullRequests } from "@project-os/contracts";
import type { WatcherConfig } from "./config.ts";
import { errorMessage, type Logger } from "./logger.ts";
import type { SessionTicket, Spawner } from "./spawn.ts";
import type { Workspaces } from "./workspace.ts";

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface WatcherDeps {
  readonly config: WatcherConfig;
  readonly client: McpClient;
  readonly spawner: Spawner;
  readonly logger: Logger;
  /** Ticket folders to clean up once their work is merged. Without it nothing is cleaned up. */
  readonly workspaces?: Pick<Workspaces, "ticketIds" | "cleanup">;
}

/**
 * Whether a ticket's work has landed: it is `completed`, its Worker reported at least one PR in
 * a result, and the Coordinator has recorded every one of them as merged. `ticket_get` without
 * an `eventLimit` returns every event, so no result or receipt is cut off.
 */
const isMerged = (out: unknown): boolean => {
  const { ticket, events } = out as { ticket?: { status?: unknown }; events?: unknown };
  if (ticket?.status !== "completed" || !Array.isArray(events)) return false;
  const prs = ticketPullRequests(events);
  return prs.links.length > 0 && prs.links.every((url) => prs.merged.has(url));
};

export const createWatcher = ({ config, client, spawner, logger, workspaces }: WatcherDeps) => {
  let running = 0;
  /** Tickets with a session under way, so a slow start isn't launched twice. */
  const inFlight = new Set<string>();
  /** Tickets whose folder is being cleaned up; their sessions wait for the next poll. */
  const cleaning = new Set<string>();
  /** Tickets cleaned up already; what is left there stays until a new session. */
  const cleaned = new Set<string>();

  const start = (ticket: SessionTicket) => {
    const ticketId = ticket.id;
    running++;
    inFlight.add(ticketId);
    cleaned.delete(ticketId);
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
    spawner.spawn(ticket).then(
      (code) => done(`code=${code}`, code !== 0),
      (e) => done(`error=${errorMessage(e)}`, true),
    );
  };

  /** Removes the worktrees of tickets with no session whose PRs are all merged. */
  const sweep = async (folders: Pick<Workspaces, "ticketIds" | "cleanup">) => {
    for (const ticketId of folders.ticketIds()) {
      if (inFlight.has(ticketId) || cleaning.has(ticketId) || cleaned.has(ticketId)) continue;
      cleaning.add(ticketId);
      try {
        // A ticket this worker can't read any more (reassigned, stopped) keeps its folder.
        if (!isMerged(await client.callTool("ticket_get", { ticketId }))) continue;
        const result = await folders.cleanup(ticketId);
        cleaned.add(ticketId);
        logger.info(`workspace: cleaned up ${ticketId}, its PRs are merged`, {
          ticketId,
          removed: result.removed.length,
        });
        for (const { path, reason } of result.kept) {
          logger.warn(`workspace: kept ${path}: ${reason}`, { ticketId });
        }
      } catch (e) {
        logger.debug(`workspace: left ${ticketId} as it is: ${errorMessage(e)}`, { ticketId });
      } finally {
        cleaning.delete(ticketId);
      }
    }
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
      })) as { tickets: ReadonlyArray<SessionTicket> };
      const waiting = out.tickets.filter((t) => !inFlight.has(t.id) && !cleaning.has(t.id));
      logger.debug(`poll: ${out.tickets.length} assigned, ${waiting.length} waiting`, {
        running,
        maxSessions: config.maxSessions,
        ticketIds: out.tickets.map((t) => t.id),
      });
      for (const ticket of waiting.slice(0, Math.max(0, config.maxSessions - running))) {
        start(ticket);
      }
      // After the sessions start, so cleaning up never holds one back.
      if (workspaces) await sweep(workspaces);
    } catch (e) {
      logger.error(`poll failed: ${errorMessage(e)}`);
    }
  };

  return { pollOnce, running: () => running };
};

import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { loadConfig } from "../../watcher/src/config.ts";
import { httpMcpClient } from "../../watcher/src/mcp-client.ts";
import { createWatcher } from "../../watcher/src/poll.ts";
import { type Stack, startStack } from "./stack.ts";
import { silentLogger } from "../../watcher/src/logger.ts";

// An Operator reassigns a stuck ticket from the dashboard API: the shared device that claimed it
// loses access, and another shared device's Watcher (real poll loop, real MCP) picks it up and
// works it through to a reply in the ticket's thread.

const CHANNEL = "chan-1";

let stack: Stack;
beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request") });
});
afterEach(() => stack.stop());

type Mcp = Awaited<ReturnType<Stack["worker"]>>;
const call = async (mcp: Mcp, name: string, args: Record<string, unknown>) =>
  (await mcp.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: any;
  };

describe("reassign a stuck ticket", () => {
  it("moves it off a stuck worker to another, whose Watcher finishes it", async () => {
    const projectId = await stack.linkChannel(CHANNEL);
    const stuck = await stack.registerSharedWorker("stuck-box");
    await forwardInbound(
      stack.coordinator,
      fakeInbound({ channelId: CHANNEL, userId: "u1", name: "Ada" }, "please add dark mode")!,
      fetch,
    );
    const [placed] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(placed).toMatchObject({ status: "assigned", workerId: stuck.workerId });
    const ticketId = placed.id as string;
    const claim = await call(stuck.mcp, "ticket_claim", { ticketId, workerId: stuck.workerId });
    expect(claim.isError).toBeFalsy();

    const fresh = await stack.registerSharedWorker("fresh-box");
    const moved = await stack.json("POST", `/tickets/${ticketId}/assign`, {
      workerId: fresh.workerId,
    });
    expect(moved).toMatchObject({ status: "assigned", workerId: fresh.workerId, startedAt: null });

    const late = await call(stuck.mcp, "ticket_update_status", { ticketId, status: "completed" });
    expect(late.isError, "the old worker can no longer touch it").toBe(true);

    const config = loadConfig(
      { server: stack.url, workerId: fresh.workerId, name: "fresh-box", secret: fresh.secret },
      () => true,
    );
    const sessions: Promise<number>[] = [];
    const watcher = createWatcher({
      config,
      client: httpMcpClient(config.mcpUrl, fetch, config.secret),
      spawner: {
        spawn: () => {
          const run = (async () => {
            const { tickets } = (
              await call(fresh.mcp, "ticket_list_assigned", { workerId: fresh.workerId })
            ).structuredContent;
            const id = tickets[0].id as string;
            await call(fresh.mcp, "ticket_claim", { ticketId: id, workerId: fresh.workerId });
            await call(fresh.mcp, "ticket_append_event", {
              ticketId: id,
              type: "result",
              actor: "worker",
              actorId: fresh.workerId,
              body: "added dark mode toggle",
            });
            await call(fresh.mcp, "ticket_update_status", { ticketId: id, status: "completed" });
            return 0;
          })();
          sessions.push(run);
          return run;
        },
      },
      logger: silentLogger,
    });
    await watcher.pollOnce();
    expect(sessions).toHaveLength(1);
    expect(await sessions[0]).toBe(0);

    const { ticket, events } = await stack.json("GET", `/tickets/${ticketId}`);
    expect(ticket).toMatchObject({ status: "completed", workerId: fresh.workerId });
    expect(events.map((e: { body: string }) => e.body)).toContain(
      "Reassigned from stuck-box to fresh-box by Admin",
    );
    expect(stack.posted.at(-1)!.content).toContain("added dark mode toggle");
  });
});

import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// Admin create_project -> HTTP ChannelGateway -> Discord adapter /channels -> linked source,
// then a message in the new channel becomes a ticket whose reply lands in that channel.

const WORKER = "w1";
let stack: Stack;

beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request"), workerId: WORKER });
});
afterEach(() => stack.stop());

describe("admin create_project creates the project's Discord channel", () => {
  it("creates the channel through the adapter and routes its messages to the project", async () => {
    const reply = await stack.admin.createProject({ name: "Acme Site" });
    expect(stack.createdChannels).toEqual(["Acme Site"]);
    expect(reply).toMatch(/Created channel #acme-site \(discord-new-1\) as its reply channel/);

    const [project] = await stack.json("GET", "/projects");
    const inbound = fakeInbound(
      { channelId: "discord-new-1", userId: "u1", name: "Ada" },
      "please add dark mode",
    );
    await forwardInbound(stack.url, inbound!, fetch);
    const tickets = await stack.json("GET", `/projects/${project.id}/tickets`);
    expect(tickets).toMatchObject([{ title: "please add dark mode" }]);

    const mcp = await stack.worker();
    const ticketId = tickets[0].id as string;
    await mcp.callTool({ name: "ticket_claim", arguments: { ticketId, workerId: WORKER } });
    await mcp.callTool({
      name: "ticket_update_status",
      arguments: { ticketId, status: "completed" },
    });
    // Thread-opened note, then the result, both in the ticket's thread in the new channel.
    const thread = { channelId: "discord-new-1", threadId: "discord-thread-1" };
    expect(stack.posted.map((p) => p.target)).toEqual([thread, thread]);
  });

  it("only creates the project when told to link an existing channel", async () => {
    await stack.admin.createProject({ name: "Acme", createChannel: false });
    expect(stack.createdChannels).toEqual([]);
    expect(await stack.json("GET", "/projects")).toHaveLength(1);
  });
});

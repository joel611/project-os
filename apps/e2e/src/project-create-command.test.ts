import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../discord-adapter/src/commands.ts";
import { fakeCommand, fakeInbound } from "../../discord-adapter/src/fake.ts";
import { forwardInbound } from "../../discord-adapter/src/forward.ts";
import { ADMIN_CHANNEL, ADMIN_USER, type Stack, startStack } from "./stack.ts";

// /project-create in Discord -> adapter normalizes + forwards -> Coordinator /commands ->
// admin create_project -> HTTP ChannelGateway -> adapter /channels -> linked source.

let stack: Stack;
beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request"), workerId: "w1" });
});
afterEach(() => stack.stop());

const admin = { channelId: ADMIN_CHANNEL, userId: ADMIN_USER, name: "Joel" };
const run = (speaker: typeof admin, options: Record<string, string>) =>
  forwardCommand(stack.url, fakeCommand(speaker, "project-create", options)!, fetch);

describe("/project-create slash command", () => {
  it("creates the project and its channel from the admin channel", async () => {
    const reply = await run(admin, { name: "Acme Site", instructions: "Ship small PRs" });
    expect(reply.ephemeral).toBe(false);
    expect(reply.content).toMatch(/Created channel #acme-site \(discord-new-1\)/);
    expect(stack.createdChannels).toEqual(["Acme Site"]);

    const [project] = await stack.json("GET", "/projects");
    expect(project).toMatchObject({ name: "Acme Site", customInstructions: "Ship small PRs" });

    // The new channel is live: a message there becomes a ticket of the project.
    const inbound = fakeInbound({ channelId: "discord-new-1", userId: "u1", name: "Ada" }, "hi");
    await forwardInbound(stack.url, inbound!, fetch);
    expect(await stack.json("GET", `/projects/${project.id}/tickets`)).toHaveLength(1);
  });

  it("refuses outside the admin channel and for non-admins, privately", async () => {
    const elsewhere = await run({ ...admin, channelId: "general" }, { name: "Acme" });
    const stranger = await run({ ...admin, userId: "someone" }, { name: "Acme" });
    expect(elsewhere).toEqual({
      content: "/project-create only works in the admin channel.",
      ephemeral: true,
    });
    expect(stranger).toMatchObject({ content: expect.stringMatching(/Not authorized/) });
    expect(await stack.json("GET", "/projects")).toEqual([]);
    expect(stack.createdChannels).toEqual([]);
  });
});

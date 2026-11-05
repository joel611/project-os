import type { SlashCommand } from "@project-os/contracts";
import { makeTestLayer } from "@project-os/testing";
import { ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.ts";
import { type CommandsConfig, runCommand } from "./commands.ts";

const command = (over: Partial<SlashCommand> = {}): SlashCommand => ({
  channelType: "discord",
  command: "project-create",
  externalId: "i1",
  channelId: "admin",
  sender: { id: "u1", name: "Joel" },
  options: { name: "Acme" },
  ...over,
});

const recording = (over: Partial<CommandsConfig> = {}) => {
  const calls: unknown[] = [];
  const config: CommandsConfig = {
    adminChannelId: "admin",
    adminUserIds: ["u1"],
    admin: { createProject: async (args) => (calls.push(args), `Created ${args.name}`) },
    ...over,
  };
  return { calls, config };
};

describe("runCommand /project-create", () => {
  it("creates the project in the admin channel and answers publicly", async () => {
    const { calls, config } = recording();
    const reply = await runCommand(
      command({ options: { name: " Acme ", instructions: " be brief " } }),
      config,
    );
    expect(reply).toEqual({ content: "Created Acme", ephemeral: false });
    expect(calls).toEqual([{ name: "Acme", customInstructions: "be brief" }]);
  });

  it("omits blank instructions", async () => {
    const { calls, config } = recording();
    await runCommand(command({ options: { name: "Acme", instructions: "  " } }), config);
    expect(calls).toEqual([{ name: "Acme" }]);
  });

  it.each([
    ["another channel", command({ channelId: "general" })],
    ["a thread of the admin channel", command({ threadId: "th1" })],
    ["another channel type", command({ channelType: "chat" })],
  ] as const)("refuses privately in %s", async (_n, cmd) => {
    const { calls, config } = recording();
    expect(await runCommand(cmd, config)).toEqual({
      content: "/project-create only works in the admin channel.",
      ephemeral: true,
    });
    expect(calls).toEqual([]);
  });

  it("refuses when no admin channel is configured", async () => {
    const { adminChannelId: _drop, ...config } = recording().config;
    expect((await runCommand(command(), config)).ephemeral).toBe(true);
  });

  it("refuses users not on the admin list, and allows anyone when no list is set", async () => {
    const { calls, config } = recording();
    expect(await runCommand(command({ sender: { id: "u2" } }), config)).toMatchObject({
      content: expect.stringMatching(/Not authorized/),
      ephemeral: true,
    });
    const { adminUserIds: _drop, ...open } = config;
    expect((await runCommand(command({ sender: { id: "u2" } }), open)).ephemeral).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("shows usage when the name is blank", async () => {
    const { calls, config } = recording();
    expect(await runCommand(command({ options: { name: " " } }), config)).toMatchObject({
      content: expect.stringMatching(/^Usage: \/project-create/),
      ephemeral: true,
    });
    expect(await runCommand(command({ options: {} }), config)).toMatchObject({ ephemeral: true });
    expect(calls).toEqual([]);
  });
});

describe("POST /commands", () => {
  const disposers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((d) => d()));
  });
  const appWith = (commands?: CommandsConfig) => {
    const runtime = ManagedRuntime.make(makeTestLayer().layer);
    disposers.push(() => runtime.dispose());
    return createApp(
      {},
      { http: { run: (e) => runtime.runPromise(e), ...(commands && { commands }) } },
    );
  };
  const post = async (app: ReturnType<typeof appWith>, body: unknown) => {
    const res = await app.handle(
      new Request("http://localhost/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  it("runs the command and returns the reply", async () => {
    const res = await post(appWith(recording().config), command());
    expect(res).toEqual({ status: 200, body: { content: "Created Acme", ephemeral: false } });
  });

  it("400s on an invalid or unknown command", async () => {
    const app = appWith(recording().config);
    expect((await post(app, { nope: true })).status).toBe(400);
    expect((await post(app, command({ command: "other" as never }))).status).toBe(400);
  });

  it("501s when commands are not configured", async () => {
    expect((await post(appWith(), command())).status).toBe(501);
  });
});

import type { SlashCommand } from "@project-os/contracts";
import { makeTestLayer } from "@project-os/testing";
import { ConnectionsUnavailable, UserConnections } from "@project-os/core";
import { Effect, Layer, ManagedRuntime } from "effect";
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

describe("runCommand account commands", () => {
  const setup = () => {
    const test = makeTestLayer();
    const runtime = ManagedRuntime.make(test.layer);
    const { config } = recording({
      connections: (effect) => runtime.runPromise(effect),
    });
    return { test, runtime, config };
  };
  const account = (name: "connect" | "disconnect" | "connections", provider?: string) =>
    command({
      command: name,
      channelId: "general",
      sender: { id: "u9", name: "Ada" },
      options: provider === undefined ? {} : { provider },
    });

  it("answers /connect privately with a link, in any channel", async () => {
    const { runtime, config } = setup();
    const reply = await runCommand(account("connect", "google"), config);
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain("http://connect.test/google/u9");
    await runtime.dispose();
  });

  it("rejects an unknown provider", async () => {
    const { runtime, config } = setup();
    const reply = await runCommand(account("connect", "dropbox"), config);
    expect(reply).toEqual({
      content: "Usage: /connect provider:<google|github>",
      ephemeral: true,
    });
    await runtime.dispose();
  });

  it("lists and removes links", async () => {
    const { test, runtime, config } = setup();
    expect((await runCommand(account("connections"), config)).content).toContain("haven't linked");
    test.link({ channelType: "discord", id: "u9" }, "github", "tok");
    expect((await runCommand(account("connections"), config)).content).toContain("Linked: GitHub");
    expect((await runCommand(account("disconnect", "github"), config)).content).toBe(
      "Disconnected GitHub.",
    );
    expect((await runCommand(account("disconnect", "github"), config)).content).toBe(
      "You had no GitHub account linked.",
    );
    await runtime.dispose();
  });

  it("works for a sender with no display name", async () => {
    const { runtime, config } = setup();
    const reply = await runCommand(
      command({ command: "connect", sender: { id: "u7" }, options: { provider: "github" } }),
      config,
    );
    expect(reply.content).toContain("http://connect.test/github/u7");
    await runtime.dispose();
  });

  it("says so when the provider has no OAuth client", async () => {
    const runtime = ManagedRuntime.make(
      Layer.succeed(UserConnections, {
        connectUrl: () => Effect.fail(new ConnectionsUnavailable({ message: "no client" })),
        list: () => Effect.succeed([]),
        disconnect: () => Effect.succeed(false),
        accessToken: () => Effect.fail(new ConnectionsUnavailable({ message: "no client" })),
      }),
    );
    const { config } = recording({ connections: (effect) => runtime.runPromise(effect) });
    expect(await runCommand(account("connect", "github"), config)).toEqual({
      content: "GitHub linking is not configured here.",
      ephemeral: true,
    });
    await runtime.dispose();
  });

  it("refuses when account linking is not configured", async () => {
    const { config } = recording();
    expect(await runCommand(account("connect", "google"), config)).toEqual({
      content: "Account linking is not configured here.",
      ephemeral: true,
    });
  });
});

describe("runCommand personal workers", () => {
  const workersConfig = () => {
    const runtime = ManagedRuntime.make(makeTestLayer().layer);
    const { config } = recording({
      workers: {
        run: (effect) => runtime.runPromise(effect),
        publicUrl: "https://coord.example.com/",
        staleMs: 15 * 60_000,
      },
    });
    return config;
  };
  const worker = (name: "register-worker" | "workers" | "unregister-worker", options = {}) =>
    command({ command: name, channelId: "general", options });

  it("/register-worker answers privately with a one-line install + register command", async () => {
    const reply = await runCommand(
      worker("register-worker", { name: "my laptop" }),
      workersConfig(),
    );
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toMatch(
      /bun install -g @project-os\/watcher && project-os-watcher register [\w-]+ --server https:\/\/coord\.example\.com --name 'my laptop'/,
    );
    expect(reply.content).toContain("10 minutes");
    expect(reply.content).toContain("shared cloud worker");
  });

  it("/workers lists the person's devices; /unregister-worker removes one", async () => {
    const config = workersConfig();
    expect((await runCommand(worker("workers"), config)).content).toContain(
      "no registered workers",
    );

    const registered = await runCommand(worker("register-worker"), config);
    const token = registered.content.match(/register ([\w-]+) --server/)![1]!;
    const { redeemWorkerRegistration } = await import("@project-os/core");
    await config.workers!.run(
      Effect.orDie(redeemWorkerRegistration({ token, hostname: "ada-mbp" })),
    );

    const listed = await runCommand(worker("workers"), config);
    expect(listed).toMatchObject({ ephemeral: true });
    expect(listed.content).toContain("**ada-mbp**");
    expect(listed.content).toContain("offline, last seen never");

    expect(
      (await runCommand(worker("unregister-worker", { worker: "nope" }), config)).content,
    ).toContain('no worker called "nope"');
    expect(
      (await runCommand(worker("unregister-worker", { worker: "ada-mbp" }), config)).content,
    ).toContain("Removed ada-mbp");
  });

  it("refuses when personal workers are not configured", async () => {
    const { config } = recording();
    expect(await runCommand(worker("register-worker"), config)).toEqual({
      content: "Personal workers are not configured here.",
      ephemeral: true,
    });
  });
});

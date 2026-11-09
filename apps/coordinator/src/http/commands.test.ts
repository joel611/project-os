import type { SlashCommand } from "@project-os/contracts";
import { makeTestLayer } from "@project-os/testing";
import { ConnectionsUnavailable, UserConnections, WorkerRepository } from "@project-os/core";
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

  it("serves the install script /register-worker points at, with the configured install step", async () => {
    const runtime = ManagedRuntime.make(makeTestLayer().layer);
    disposers.push(() => runtime.dispose());
    const { config } = recording({
      workers: {
        run: (effect) => runtime.runPromise(effect),
        publicUrl: "https://coord.example.com/",
        installCommand: "npm i -g watcher",
        staleMs: 1,
      },
    });
    const res = await appWith(config).handle(new Request("http://localhost/watcher/install.sh"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    const script = await res.text();
    expect(script).toContain("server=https://coord.example.com\n");
    expect(script).toContain("\nnpm i -g watcher\n");
  });

  it("501s the install script when registered workers are not configured", async () => {
    const res = await appWith(recording().config).handle(
      new Request("http://localhost/watcher/install.sh"),
    );
    expect(res.status).toBe(501);
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

  it("/register-worker answers privately with the install script line, and how to uninstall", async () => {
    const reply = await runCommand(
      worker("register-worker", { name: "my laptop" }),
      workersConfig(),
    );
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toMatch(
      /curl -fsSL https:\/\/coord\.example\.com\/watcher\/install\.sh \| sh -s -- [\w-]+ --name 'my laptop'/,
    );
    expect(reply.content).toContain("which agent and model");
    expect(reply.content).toContain("`project-os-watcher uninstall`");
    expect(reply.content).toContain("10 minutes");
    expect(reply.content).toContain("your tickets go to the shared pool");
  });

  it("/register-worker agent: and model: put --agent, --model and --yes in the line, so nothing is asked", async () => {
    const reply = await runCommand(
      worker("register-worker", { agent: "codex", model: " gpt 5 " }),
      workersConfig(),
    );
    expect(reply.content).toMatch(/sh -s -- [\w-]+ --agent codex --model 'gpt 5' --yes\n/);
    expect(reply.content).toContain("runs sessions on codex (model gpt 5) without asking");
    expect(reply.content).not.toContain("which agent and model");

    const defaults = await runCommand(worker("register-worker", { agent: "pi" }), workersConfig());
    expect(defaults.content).toContain("--agent pi --yes");
    expect(defaults.content).toContain("pi (the agent's default model)");
  });

  it("/register-worker refuses an unknown agent without issuing a code", async () => {
    const config = workersConfig();
    const reply = await runCommand(worker("register-worker", { agent: "gemini" }), config);
    expect(reply).toEqual({
      content: "agent must be one of claude, pi, codex.",
      ephemeral: true,
    });
  });

  it("/workers lists the person's devices; /unregister-worker removes one", async () => {
    const config = workersConfig();
    expect((await runCommand(worker("workers"), config)).content).toContain(
      "no registered workers",
    );

    const registered = await runCommand(worker("register-worker"), config);
    const token = registered.content.match(/sh -s -- ([\w-]+)/)![1]!;
    const { redeemWorkerRegistration } = await import("@project-os/core");
    await config.workers!.run(
      Effect.orDie(redeemWorkerRegistration({ token, hostname: "ada-mbp" })),
    );

    const listed = await runCommand(worker("workers"), config);
    expect(listed).toMatchObject({ ephemeral: true });
    expect(listed.content).toContain("**ada-mbp**");
    expect(listed.content).toContain("offline, last seen never");

    // Seen once, a while ago (the test clock is 2026-11-04T00:00Z).
    await config.workers!.run(
      Effect.gen(function* () {
        const repo = yield* WorkerRepository;
        const [w] = yield* repo.list;
        yield* repo.heartbeat({
          workerId: w!.id,
          workerType: "local",
          ticketId: null,
          at: "2026-11-03T20:15:00.000Z",
        });
      }),
    );
    expect((await runCommand(worker("workers"), config)).content).toContain(
      "offline, last seen 2026-11-03 20:15 UTC",
    );

    expect(
      (await runCommand(worker("unregister-worker", { worker: "nope" }), config)).content,
    ).toContain('no worker called "nope"');
    expect(
      (await runCommand(worker("unregister-worker", { worker: "ada-mbp" }), config)).content,
    ).toContain("Removed ada-mbp");
    expect((await runCommand(worker("unregister-worker", { worker: " " }), config)).content).toBe(
      "Usage: /unregister-worker worker:<name or id> [shared:True]",
    );
  });

  it("refuses when registered workers are not configured", async () => {
    const { config } = recording();
    expect(await runCommand(worker("register-worker"), config)).toEqual({
      content: "Registered workers are not configured here.",
      ephemeral: true,
    });
  });

  describe("shared:True (admins, in the admin channel)", () => {
    const shared = (
      name: "register-worker" | "workers" | "unregister-worker",
      options: Record<string, string> = {},
      over: Partial<SlashCommand> = {},
    ) =>
      command({
        command: name,
        channelId: "admin",
        options: { shared: "true", ...options },
        ...over,
      });

    it("refuses outside the admin channel, and to non-admins", async () => {
      const config = workersConfig();
      expect(
        (await runCommand(shared("register-worker", {}, { channelId: "general" }), config)).content,
      ).toBe("/register-worker shared:True only works in the admin channel.");
      expect(
        (await runCommand(shared("workers", {}, { sender: { id: "u2" } }), config)).content,
      ).toBe("Not authorized: you are not on the admin list.");
    });

    it("registers a shared device, lists it for everyone, and removes it", async () => {
      const config = workersConfig();
      expect((await runCommand(shared("workers"), config)).content).toContain(
        "There are no shared workers",
      );

      const registered = await runCommand(shared("register-worker"), config);
      expect(registered.content).toContain("should join the shared pool");
      expect(registered.content).toContain("/unregister-worker shared:True");
      const token = registered.content.match(/sh -s -- ([\w-]+)/)![1]!;
      const { redeemWorkerRegistration } = await import("@project-os/core");
      const { worker: device } = await config.workers!.run(
        Effect.orDie(redeemWorkerRegistration({ token, hostname: "build-box" })),
      );
      expect(device).toMatchObject({ ownerId: null, registered: true });
      expect(device.id).toMatch(/^shared-/);

      expect((await runCommand(shared("workers"), config)).content).toBe(
        `Shared workers:\n- **build-box** (\`${device.id}\`): offline, last seen never`,
      );
      // Members see the pool next to their own devices (none here).
      const mine = await runCommand(worker("workers"), config);
      expect(mine.content).toContain("no registered workers");
      expect(mine.content).toContain("**build-box**");
      // ...and can't remove it as one of theirs.
      expect(
        (await runCommand(worker("unregister-worker", { worker: "build-box" }), config)).content,
      ).toContain('no worker called "build-box"');

      expect(
        (await runCommand(shared("unregister-worker", { worker: "nope" }), config)).content,
      ).toContain('no shared worker called "nope"');
      expect(
        (await runCommand(shared("unregister-worker", { worker: "BUILD-BOX" }), config)).content,
      ).toContain("Removed build-box");
    });

    it("shows a member both their devices and the pool", async () => {
      const config = workersConfig();
      const { redeemWorkerRegistration } = await import("@project-os/core");
      for (const [cmd, hostname] of [
        [shared("register-worker"), "build-box"],
        [worker("register-worker"), "ada-mbp"],
      ] as const) {
        const token = (await runCommand(cmd, config)).content.match(/sh -s -- ([\w-]+)/)![1]!;
        await config.workers!.run(Effect.orDie(redeemWorkerRegistration({ token, hostname })));
      }
      const listed = (await runCommand(worker("workers"), config)).content.split("\n");
      expect(listed[0]).toBe("Your workers:");
      expect(listed[1]).toContain("**ada-mbp**");
      expect(listed[2]).toBe("Shared workers:");
      expect(listed[3]).toContain("**build-box**");
    });
  });
});

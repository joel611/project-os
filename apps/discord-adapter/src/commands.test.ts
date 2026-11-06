import type { SlashCommand } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  answerCommand,
  COMMAND_DEFINITIONS,
  type DiscordCommandLike,
  forwardCommand,
  type InteractionReplier,
  normalizeCommand,
} from "./commands.ts";

const interaction = (over: Partial<DiscordCommandLike> = {}): DiscordCommandLike => ({
  id: "i1",
  commandName: "project-create",
  channelId: "admin",
  channel: { isThread: () => false },
  user: { id: "u1", username: "joel" },
  member: { displayName: "Joel" },
  options: { data: [{ name: "name", value: "Acme" }] },
  ...over,
});

const command: SlashCommand = {
  channelType: "discord",
  command: "project-create",
  externalId: "i1",
  channelId: "admin",
  sender: { id: "u1", name: "Joel" },
  options: { name: "Acme" },
};

describe("COMMAND_DEFINITIONS", () => {
  it("defines /project-create with a required name", () => {
    expect(COMMAND_DEFINITIONS.map((c) => c.name)).toEqual([
      "project-create",
      "connect",
      "disconnect",
      "connections",
    ]);
    expect(COMMAND_DEFINITIONS[0].options[0]).toMatchObject({ name: "name", required: true });
  });

  it("offers google and github as the only /connect providers", () => {
    const connect = COMMAND_DEFINITIONS.find((c) => c.name === "connect")!;
    expect(connect.options[0]).toMatchObject({ name: "provider", required: true });
    expect(connect.options[0]!.choices.map((c) => c.value)).toEqual(["google", "github"]);
  });

  it("offers no command in DMs: the bot only works in the server", () => {
    expect(COMMAND_DEFINITIONS.every((c) => c.dm_permission === false)).toBe(true);
  });
});

describe("normalizeCommand", () => {
  it("normalizes /project-create with its options", () => {
    const opts = { data: [{ name: "name", value: "Acme" }, { name: "instructions" }] };
    expect(normalizeCommand(interaction({ options: opts }))).toEqual(command);
  });

  it("uses the parent channel and thread id inside a thread", () => {
    const out = normalizeCommand(
      interaction({
        channelId: "th1",
        channel: { isThread: () => true, parentId: "admin" },
        member: null,
      }),
    );
    expect(out).toMatchObject({ channelId: "admin", threadId: "th1", sender: { name: "joel" } });
  });

  it("falls back to the channel id when a thread has no parent, or no channel is cached", () => {
    const thread = interaction({ channelId: "th1", channel: { isThread: () => true } });
    expect(normalizeCommand(thread)).toMatchObject({ channelId: "th1", threadId: "th1" });
    expect(normalizeCommand(interaction({ channel: null }))?.threadId).toBeUndefined();
  });

  it("ignores commands it doesn't own", () => {
    expect(normalizeCommand(interaction({ commandName: "other" }))).toBeNull();
  });
});

describe("forwardCommand", () => {
  it("POSTs to <coordinator>/commands and decodes the reply", async () => {
    let seen: Request | undefined;
    const fetcher = async (r: Request) => (
      (seen = r),
      Response.json({ content: "ok", ephemeral: false })
    );
    expect(await forwardCommand("http://c:8080/", command, fetcher)).toEqual({
      content: "ok",
      ephemeral: false,
    });
    expect(seen?.url).toBe("http://c:8080/commands");
    expect(await seen?.json()).toEqual(command);
  });

  it("throws on non-2xx", async () => {
    const fetcher = async () => new Response("no", { status: 400 });
    await expect(forwardCommand("http://c", command, fetcher)).rejects.toThrow(/400/);
  });
});

const recorder = () => {
  const calls: unknown[][] = [];
  const replier: InteractionReplier = {
    defer: async (e) => void calls.push(["defer", e]),
    edit: async (c) => void calls.push(["edit", c]),
    remove: async () => void calls.push(["remove"]),
    followUp: async (c, e) => void calls.push(["followUp", c, e]),
  };
  return { calls, replier };
};
const replying = (content: string, ephemeral: boolean) => async () =>
  Response.json({ content, ephemeral });

describe("answerCommand", () => {
  it("answers publicly in the admin channel", async () => {
    const { calls, replier } = recorder();
    await answerCommand(command, replier, {
      coordinatorUrl: "http://c",
      adminChannelId: "admin",
      fetcher: replying("Created", false),
    });
    expect(calls).toEqual([
      ["defer", false],
      ["edit", "Created"],
    ]);
  });

  it("turns a refusal in the admin channel into a private follow-up", async () => {
    const { calls, replier } = recorder();
    await answerCommand(command, replier, {
      coordinatorUrl: "http://c",
      adminChannelId: "admin",
      fetcher: replying("Not authorized", true),
    });
    expect(calls).toEqual([["defer", false], ["remove"], ["followUp", "Not authorized", true]]);
  });

  it("defers privately outside the admin channel, or when it is unknown", async () => {
    for (const adminChannelId of ["elsewhere", undefined]) {
      const { calls, replier } = recorder();
      await answerCommand(command, replier, {
        coordinatorUrl: "http://c",
        ...(adminChannelId && { adminChannelId }),
        fetcher: replying("admin channel only", true),
      });
      expect(calls).toEqual([
        ["defer", true],
        ["edit", "admin channel only"],
      ]);
    }
  });

  it("tells the user privately when the Coordinator can't be reached", async () => {
    const { calls, replier } = recorder();
    await answerCommand(command, replier, {
      coordinatorUrl: "http://c",
      adminChannelId: "admin",
      fetcher: async () => new Response("", { status: 500 }),
    });
    expect(calls.at(-1)).toEqual([
      "followUp",
      "Something went wrong reaching the Coordinator.",
      true,
    ]);
  });
});

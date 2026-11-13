import { Schema } from "effect";
import {
  CommandReply,
  type SlashCommand,
  type SlashCommandName,
  WATCHER_AGENTS,
} from "@project-os/contracts";
import { type CoordinatorTarget, type Fetcher, postToCoordinator } from "./forward.ts";

const PROVIDER_OPTION = {
  name: "provider",
  description: "Which account",
  type: 3,
  required: true,
  choices: [
    { name: "Google (Drive)", value: "google" },
    { name: "GitHub", value: "github" },
    { name: "ClickUp (task files)", value: "clickup" },
  ],
} as const;

/**
 * Slash commands this adapter registers with Discord (application command JSON, type 1 =
 * chat input, option type 3 = string, 5 = boolean). Discord can't limit a bot's command to one
 * channel, so the Coordinator refuses admin commands outside the admin channel. Account commands
 * (/connect, /disconnect, /connections) and personal worker commands (/register-worker,
 * /workers, /unregister-worker) work in any server channel and answer privately. Their
 * `shared` option manages the shared pool instead, for admins in the admin channel only.
 * /source-add links a GitHub repo or Google Drive folder to the project whose channel it runs
 * in. The bot only works in the server, so no command is offered in DMs.
 */
const SHARED_OPTION = {
  name: "shared",
  description: "Admins: the shared pool of workers instead of your own (admin channel only)",
  type: 5,
  required: false,
} as const;

export const COMMAND_DEFINITIONS = [
  {
    name: "project-create",
    description: "Create a project and its Discord channel (admin channel only)",
    type: 1,
    dm_permission: false,
    options: [
      { name: "name", description: "Project name", type: 3, required: true, max_length: 100 },
      {
        name: "instructions",
        description: "Custom instructions for the project's agents",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "connect",
    description: "Link your Google, GitHub or ClickUp account so I work with your own access",
    type: 1,
    dm_permission: false,
    options: [PROVIDER_OPTION],
  },
  {
    name: "disconnect",
    description: "Unlink your Google, GitHub or ClickUp account",
    type: 1,
    dm_permission: false,
    options: [PROVIDER_OPTION],
  },
  {
    name: "connections",
    description: "Show which of your accounts are linked",
    type: 1,
    dm_permission: false,
    options: [],
  },
  {
    name: "dashboard",
    description: "See the tickets you started or took part in on the web dashboard",
    type: 1,
    dm_permission: false,
    options: [],
  },
  {
    name: "register-worker",
    description: "Use your own computer as your worker: get a one-time command to run there",
    type: 1,
    dm_permission: false,
    options: [
      {
        name: "name",
        description: "A name for this computer (default: its hostname)",
        type: 3,
        required: false,
        max_length: 60,
      },
      {
        name: "agent",
        description: "Skip the install script's questions: which agent CLI that computer runs",
        type: 3,
        required: false,
        choices: WATCHER_AGENTS.map((agent) => ({ name: agent, value: agent })),
      },
      {
        name: "model",
        description: "The agent's model (default: the agent's own); use with agent",
        type: 3,
        required: false,
        max_length: 100,
      },
      SHARED_OPTION,
    ],
  },
  {
    name: "workers",
    description: "Show your registered computers and whether they're online",
    type: 1,
    dm_permission: false,
    options: [SHARED_OPTION],
  },
  {
    name: "unregister-worker",
    description: "Remove one of your registered computers",
    type: 1,
    dm_permission: false,
    options: [
      {
        name: "worker",
        description: "Its name or id (see /workers)",
        type: 3,
        required: true,
        max_length: 100,
      },
      SHARED_OPTION,
    ],
  },
  {
    name: "source-add",
    description: "Link a GitHub repo or Google Drive folder to this channel's project",
    type: 1,
    dm_permission: false,
    options: [
      {
        name: "link",
        description: "GitHub repo or Google Drive folder link (owner/repo also works)",
        type: 3,
        required: true,
        max_length: 500,
      },
      {
        name: "alias",
        description: "Short name for it, like design-docs (default for a repo: its name)",
        type: 3,
        required: false,
        max_length: 40,
      },
      {
        name: "description",
        description: "What it's for, so workers know when to use it",
        type: 3,
        required: false,
        max_length: 300,
      },
    ],
  },
] as const;
// Every registered command must be one the Coordinator knows.
COMMAND_DEFINITIONS satisfies ReadonlyArray<{ readonly name: SlashCommandName }>;

const NAMES: ReadonlySet<string> = new Set(COMMAND_DEFINITIONS.map((c) => c.name));

/** Structural subset of a discord.js `ChatInputCommandInteraction`, so tests need no Discord. */
export interface DiscordCommandLike {
  id: string;
  commandName: string;
  channelId: string;
  channel: { isThread(): boolean; parentId?: string | null } | null;
  user: { id: string; username: string };
  /** A `GuildMember` (has `displayName`) or, for uncached guilds, a raw API member. */
  member?: object | null;
  options: { data: ReadonlyArray<{ name: string; value?: string | number | boolean }> };
}

const displayName = (member: object | null | undefined): string | undefined =>
  member && "displayName" in member && typeof member.displayName === "string"
    ? member.displayName
    : undefined;

/** Normalizes one of our commands; returns null for commands this adapter doesn't own. */
export const normalizeCommand = (i: DiscordCommandLike): SlashCommand | null => {
  if (!NAMES.has(i.commandName)) return null;
  const inThread = i.channel?.isThread() ?? false;
  const options: Record<string, string> = {};
  for (const o of i.options.data) if (o.value !== undefined) options[o.name] = String(o.value);
  return {
    channelType: "discord",
    command: i.commandName as SlashCommandName,
    externalId: i.id,
    channelId: inThread ? (i.channel?.parentId ?? i.channelId) : i.channelId,
    ...(inThread ? { threadId: i.channelId } : {}),
    sender: { id: i.user.id, name: displayName(i.member) ?? i.user.username },
    options,
  };
};

const decodeReply = Schema.decodeUnknownSync(CommandReply);

/** POSTs a command to the Coordinator's /commands and returns what to show the user. */
export const forwardCommand = async (
  coordinator: CoordinatorTarget,
  command: SlashCommand,
  fetcher: Fetcher,
): Promise<CommandReply> => {
  const res = await postToCoordinator(coordinator, "/commands", command, fetcher);
  if (!res.ok) throw new Error(`Coordinator /commands responded ${res.status}`);
  return decodeReply(await res.json());
};

/** The calls `answerCommand` makes on a deferred interaction. */
export interface InteractionReplier {
  /** Acknowledges within Discord's 3 s limit; `ephemeral` hides the answer from others. */
  defer(ephemeral: boolean): Promise<void>;
  edit(content: string): Promise<void>;
  /** Removes the deferred reply (used to turn a public answer into a private one). */
  remove(): Promise<void>;
  followUp(content: string, ephemeral: boolean): Promise<void>;
}

/**
 * Defers, forwards, then answers. Outside `adminChannelId` it defers privately, since the
 * Coordinator will refuse; in the admin channel a refusal still ends up private.
 */
export const answerCommand = async (
  command: SlashCommand,
  replier: InteractionReplier,
  deps: {
    readonly coordinator: CoordinatorTarget;
    readonly adminChannelId?: string;
    fetcher: Fetcher;
  },
): Promise<void> => {
  const deferredPrivately =
    deps.adminChannelId === undefined || command.channelId !== deps.adminChannelId;
  await replier.defer(deferredPrivately);
  let reply: CommandReply;
  try {
    reply = await forwardCommand(deps.coordinator, command, deps.fetcher);
  } catch (err) {
    console.error("forward command to coordinator failed", err);
    reply = { content: "Something went wrong reaching the Coordinator.", ephemeral: true };
  }
  if (reply.ephemeral && !deferredPrivately) {
    await replier.remove();
    await replier.followUp(reply.content, true);
    return;
  }
  await replier.edit(reply.content);
};

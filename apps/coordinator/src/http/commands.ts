import type { AdminActions } from "@project-os/agent-runtime";
import {
  type CommandReply,
  type ConnectionProvider,
  CONNECTION_PROVIDERS,
  type SlashCommand,
} from "@project-os/contracts";
import { type Person, PROVIDER_LABELS, UserConnections } from "@project-os/core";
import { Effect } from "effect";

export interface CommandsConfig {
  /** Discord channel id of the admin channel; admin commands run only there. Unset: refused. */
  readonly adminChannelId?: string;
  /** Discord user ids allowed to run admin commands. Unset: no check. Empty: nobody. */
  readonly adminUserIds?: ReadonlyArray<string>;
  /** The same actions the admin dialogue's tools call. */
  readonly admin: Pick<AdminActions, "createProject">;
  /** Runs account-linking effects (/connect, /disconnect, /connections). Unset: refused. */
  readonly connections?: <A>(effect: Effect.Effect<A, never, UserConnections>) => Promise<A>;
}

const privately = (content: string): CommandReply => ({ content, ephemeral: true });

/**
 * Runs a slash command forwarded by a Channel Adapter. Admin commands are deterministic
 * shortcuts to the admin dialogue's actions, held to the same admin channel and user list.
 * Account commands work anywhere and always answer privately.
 */
export const runCommand = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  switch (command.command) {
    case "project-create":
      return projectCreate(command, config);
    case "connect":
    case "disconnect":
    case "connections":
      return accountCommand(command, config);
  }
};

const projectCreate = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  const inAdminChannel =
    config.adminChannelId !== undefined &&
    command.channelType === "discord" &&
    command.channelId === config.adminChannelId &&
    command.threadId === undefined;
  if (!inAdminChannel) return privately(`/${command.command} only works in the admin channel.`);
  if (config.adminUserIds && !config.adminUserIds.includes(command.sender.id)) {
    return privately("Not authorized: you are not on the admin list.");
  }

  const name = command.options.name?.trim();
  if (!name) return privately("Usage: /project-create name:<project name> [instructions:<text>]");
  const instructions = command.options.instructions?.trim();
  const content = await config.admin.createProject({
    name,
    ...(instructions ? { customInstructions: instructions } : {}),
  });
  return { content, ephemeral: false };
};

const withConnections = <A>(f: (c: UserConnections["Service"]) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    return yield* f(yield* UserConnections);
  });

const isProvider = (value: string | undefined): value is ConnectionProvider =>
  (CONNECTION_PROVIDERS as ReadonlyArray<string | undefined>).includes(value);

const accountCommand = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  if (!config.connections) return privately("Account linking is not configured here.");
  const person: Person = {
    channelType: command.channelType,
    id: command.sender.id,
    ...(command.sender.name ? { name: command.sender.name } : {}),
  };

  if (command.command === "connections") {
    const linked = await config.connections(withConnections((c) => c.list(person)));
    if (linked.length === 0) {
      return privately("You haven't linked any accounts. Run `/connect` to link Google or GitHub.");
    }
    return privately(
      `Linked: ${linked.map((a) => PROVIDER_LABELS[a.provider]).join(", ")}. I use these when working on what you ask for.`,
    );
  }

  const provider = command.options.provider?.trim().toLowerCase();
  if (!isProvider(provider)) {
    return privately(`Usage: /${command.command} provider:<${CONNECTION_PROVIDERS.join("|")}>`);
  }
  const label = PROVIDER_LABELS[provider];

  if (command.command === "disconnect") {
    const removed = await config.connections(
      withConnections((c) => c.disconnect(person, provider)),
    );
    return privately(removed ? `Disconnected ${label}.` : `You had no ${label} account linked.`);
  }

  const url = await config.connections(
    withConnections((c) =>
      c.connectUrl(person, provider).pipe(Effect.orElseSucceed((): string | null => null)),
    ),
  );
  if (!url) return privately(`${label} linking is not configured here.`);
  return privately(
    `Open this link to connect your ${label} account (works once, for 10 minutes): ${url}\nI'll then use your own ${label} access for what you ask, so I only see what you can see.`,
  );
};

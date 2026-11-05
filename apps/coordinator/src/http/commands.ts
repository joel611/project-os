import type { AdminActions } from "@project-os/agent-runtime";
import type { CommandReply, SlashCommand } from "@project-os/contracts";

export interface CommandsConfig {
  /** Discord channel id of the admin channel; admin commands run only there. Unset: refused. */
  readonly adminChannelId?: string;
  /** Discord user ids allowed to run admin commands. Unset: no check. Empty: nobody. */
  readonly adminUserIds?: ReadonlyArray<string>;
  /** The same actions the admin dialogue's tools call. */
  readonly admin: Pick<AdminActions, "createProject">;
}

const privately = (content: string): CommandReply => ({ content, ephemeral: true });

/**
 * Runs a slash command forwarded by a Channel Adapter. Admin commands are deterministic
 * shortcuts to the admin dialogue's actions, held to the same admin channel and user list.
 */
export const runCommand = async (
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

  // `command.command` is a closed set (SlashCommandName); project-create is the only one today.
  const name = command.options.name?.trim();
  if (!name) return privately("Usage: /project-create name:<project name> [instructions:<text>]");
  const instructions = command.options.instructions?.trim();
  const content = await config.admin.createProject({
    name,
    ...(instructions ? { customInstructions: instructions } : {}),
  });
  return { content, ephemeral: false };
};

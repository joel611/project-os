import type { ChannelType } from "@project-os/contracts";
import type { ProjectSourceType } from "../../domain/index.ts";

/** Channel adapters speak `ChannelType`; project sources are typed more finely. */
export const sourceTypeFor = (channel: ChannelType): ProjectSourceType | undefined =>
  channel === "discord" ? "discord_channel" : channel === "email" ? "email_address" : undefined;

export const channelTypeFor = (source: ProjectSourceType): ChannelType | undefined =>
  source === "discord_channel" ? "discord" : source === "email_address" ? "email" : undefined;

import type { ChannelType, ProjectSourceType } from "@project-os/contracts";

/** Channel adapters speak `ChannelType`; project sources are typed more finely. */
export const CHANNEL_SOURCE_TYPES = {
  discord: "discord_channel",
  email: "email_address",
} as const satisfies Partial<Record<ChannelType, ProjectSourceType>>;

const SOURCE_CHANNEL_TYPES: Partial<Record<ProjectSourceType, ChannelType>> = Object.fromEntries(
  Object.entries(CHANNEL_SOURCE_TYPES).map(([channel, source]) => [source, channel]),
);

export const sourceTypeFor = (channel: ChannelType): ProjectSourceType | undefined =>
  (CHANNEL_SOURCE_TYPES as Partial<Record<ChannelType, ProjectSourceType>>)[channel];

export const channelTypeFor = (source: ProjectSourceType): ChannelType | undefined =>
  SOURCE_CHANNEL_TYPES[source];

/** Channels whose adapter can open a thread on a message, so each Ticket gets its own. */
export const supportsThreads = (channel: ChannelType): boolean => channel === "discord";

/** Channels whose adapter can react to a message, so the Coordinator can acknowledge it. */
export const supportsReactions = (channel: ChannelType): boolean => channel === "discord";

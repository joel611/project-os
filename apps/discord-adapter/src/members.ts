/**
 * Member role gate (DISCORD_MEMBER_ROLE_IDS): when set, only people holding at least one of
 * these Discord roles can trigger the bot. Everyone else is ignored before anything reaches
 * the Coordinator. Unset (or empty) means no gate.
 */

/** Parses a comma-separated role id list; `undefined` when unset or empty, i.e. no gate. */
export const parseRoleIds = (raw: string | undefined): ReadonlySet<string> | undefined => {
  const ids = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length === 0 ? undefined : new Set(ids);
};

/**
 * Role ids of a guild member. Handles a discord.js `GuildMember` (`roles.cache`, a Map keyed
 * by role id) and the raw API member interactions carry for uncached guilds (`roles: string[]`).
 * No member (a DM) has no roles.
 */
export const memberRoleIds = (member: unknown): ReadonlyArray<string> => {
  if (!member || typeof member !== "object" || !("roles" in member)) return [];
  const roles = member.roles;
  if (Array.isArray(roles)) return roles.filter((r): r is string => typeof r === "string");
  if (roles && typeof roles === "object" && "cache" in roles) {
    const cache = roles.cache;
    if (cache instanceof Map) return [...cache.keys()];
  }
  return [];
};

/** True when there's no gate, or the member holds at least one allowed role. */
export const isAllowedMember = (
  member: unknown,
  allowedRoleIds: ReadonlySet<string> | undefined,
): boolean =>
  allowedRoleIds === undefined || memberRoleIds(member).some((id) => allowedRoleIds.has(id));

export const NOT_A_MEMBER_MESSAGE = "Sorry, you need a member role to use this bot.";

export const SERVER_ONLY_MESSAGE = "I only work in the server. Run this in a server channel.";

/**
 * Member role gate (DISCORD_MEMBER_ROLE_IDS): when set, only people holding at least one of
 * these Discord roles, or listed in ADMIN_USER_IDS, can trigger the bot. Everyone else is ignored before anything reaches
 * the Coordinator. Unset (or empty) means no gate.
 */

/** Parses a comma-separated id list; `undefined` when unset or empty (for roles: no gate). */
export const parseIds = (raw: string | undefined): ReadonlySet<string> | undefined => {
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

export interface MemberGate {
  /** Roles that may trigger the bot; `undefined` means no gate. */
  readonly roleIds: ReadonlySet<string> | undefined;
  /** ADMIN_USER_IDS: admins always pass, whatever roles they hold. */
  readonly adminUserIds?: ReadonlySet<string> | undefined;
}

/** True when there's no gate, the user is an admin, or the member holds an allowed role. */
export const isAllowedMember = (userId: string, member: unknown, gate: MemberGate): boolean => {
  const { roleIds, adminUserIds } = gate;
  if (roleIds === undefined || adminUserIds?.has(userId)) return true;
  return memberRoleIds(member).some((id) => roleIds.has(id));
};

export const NOT_A_MEMBER_MESSAGE = "Sorry, you need a member role to use this bot.";

export const SERVER_ONLY_MESSAGE = "I only work in the server. Run this in a server channel.";

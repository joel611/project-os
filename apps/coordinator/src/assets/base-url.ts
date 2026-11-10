type Env = Readonly<Record<string, string | undefined>>;

/**
 * Where Workers download stored files from. A cloud sandbox can't reach the host's localhost, so
 * when `SANDBOX_MCP_URL` (the public URL the sandbox pool gives sandboxes) is set, links use its
 * origin; the Coordinator behind it serves `/assets` too. Otherwise `PUBLIC_URL`.
 */
export const assetBaseUrl = (env: Env, publicUrl: string): string => {
  const sandboxMcp = env.SANDBOX_MCP_URL || env.DAYTONA_MCP_URL;
  return sandboxMcp ? new URL(sandboxMcp).origin : publicUrl;
};

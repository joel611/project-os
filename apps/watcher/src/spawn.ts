import { fileURLToPath } from "node:url";
import type { WatcherConfig } from "./config.ts";

export interface Spawner {
  /** Runs one Claude Code session; resolves with its exit code. */
  spawn(): Promise<number>;
}

const PROMPT_PATH = fileURLToPath(new URL("../prompts/session-start.md", import.meta.url));

/** Name of the Coordinator in the MCP config; tool permissions are keyed on it. */
export const MCP_SERVER_NAME = "project-os";

export const mcpConfigJson = (config: WatcherConfig): string =>
  JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: config.mcpUrl,
        headers: { Authorization: `Bearer ${config.secret}` },
      },
    },
  });

/** `mcpConfig`: inline JSON, or the path of a file holding it (keeps a secret out of `ps`). */
export const claudeArgs = (
  config: WatcherConfig,
  prompt: string,
  mcpConfig: string = mcpConfigJson(config),
): string[] => [
  "claude",
  "-p",
  prompt,
  "--mcp-config",
  mcpConfig,
  // Headless `-p` cannot prompt, so pre-approve every Coordinator MCP tool (and nothing else).
  "--allowedTools",
  `mcp__${MCP_SERVER_NAME}__*`,
];

export type SpawnProcess = (
  cmd: string[],
  options: { cwd: string; stdout: "inherit"; stderr: "inherit" },
) => { exited: Promise<number> };

export const bunSpawner = (
  config: WatcherConfig,
  spawnProcess: SpawnProcess,
  options: { readonly mcpConfigFile?: string } = {},
): Spawner => ({
  spawn: async () => {
    const prompt = `${await Bun.file(PROMPT_PATH).text()}\nYour worker_id is \`${config.workerId}\`.`;
    const proc = spawnProcess(claudeArgs(config, prompt, options.mcpConfigFile), {
      cwd: config.cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  },
});

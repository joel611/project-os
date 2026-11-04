import { join } from "node:path";
import type { WatcherConfig } from "./config.ts";

export interface Spawner {
  /** Runs one Claude Code session; resolves with its exit code. */
  spawn(): Promise<number>;
}

const PROMPT_PATH = join(import.meta.dir, "..", "prompts", "session-start.md");

export const mcpConfigJson = (config: WatcherConfig): string =>
  JSON.stringify({ mcpServers: { "project-os": { type: "http", url: config.mcpUrl } } });

export const claudeArgs = (config: WatcherConfig, prompt: string): string[] => [
  "claude",
  "-p",
  prompt,
  "--mcp-config",
  mcpConfigJson(config),
];

export const bunSpawner = (config: WatcherConfig): Spawner => ({
  spawn: async () => {
    const prompt = `${await Bun.file(PROMPT_PATH).text()}\nYour worker_id is \`${config.workerId}\`.`;
    const proc = Bun.spawn(claudeArgs(config, prompt), {
      cwd: config.cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  },
});

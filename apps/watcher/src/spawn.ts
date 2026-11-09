import { fileURLToPath } from "node:url";
import { AGENTS, type Agent } from "./agents.ts";
import type { WatcherConfig } from "./config.ts";

export interface Spawner {
  /** Runs one agent session; resolves with its exit code. */
  spawn(): Promise<number>;
}

const PROMPT_PATH = fileURLToPath(new URL("../prompts/session-start.md", import.meta.url));

export type SpawnProcess = (
  cmd: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdout: "inherit";
    stderr: "inherit";
  },
) => { exited: Promise<number> };

export interface SpawnerIo {
  readonly readFile: (path: string) => string | undefined;
  readonly writePrivate: (path: string, contents: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly configDir: string;
  readonly home: string;
}

export const bunSpawner = (
  config: WatcherConfig,
  spawnProcess: SpawnProcess,
  io: SpawnerIo,
  agent: Agent = AGENTS[config.agent],
): Spawner => {
  return {
    spawn: async () => {
      const prompt = `${await Bun.file(PROMPT_PATH).text()}\nYour worker_id is \`${config.workerId}\`.`;
      const launch = agent.launch({ config, prompt, configDir: io.configDir, home: io.home });
      for (const file of launch.files) {
        io.writePrivate(file.path, file.update(io.readFile(file.path)));
      }
      const proc = spawnProcess([...launch.cmd], {
        cwd: config.cwd,
        env: { ...io.env, ...launch.env },
        stdout: "inherit",
        stderr: "inherit",
      });
      return proc.exited;
    },
  };
};

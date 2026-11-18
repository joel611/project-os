import { workerSessionStart } from "@project-os/system-prompts";
import { AGENTS, type Agent } from "./agents.ts";
import type { WatcherConfig } from "./config.ts";

export interface Spawner {
  /**
   * Runs one agent session; resolves with its exit code. `onOutput` also receives everything the
   * agent prints (stdout and stderr), as text.
   */
  spawn(onOutput?: (chunk: string) => void): Promise<number>;
}

export type SpawnProcess = (
  cmd: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdout: "pipe";
    stderr: "pipe";
  },
) => {
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | undefined;
  stderr?: ReadableStream<Uint8Array> | undefined;
};

export interface SpawnerIo {
  readonly readFile: (path: string) => string | undefined;
  readonly writePrivate: (path: string, contents: string) => void;
  /** Shows agent output on the Watcher's own terminal. */
  readonly write: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
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
  const pump = async (
    name: "stdout" | "stderr",
    stream: ReadableStream<Uint8Array> | undefined,
    onOutput: ((chunk: string) => void) | undefined,
  ) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      io.write(name, chunk);
      onOutput?.(decoder.decode(chunk, { stream: true }));
    }
  };

  return {
    spawn: async (onOutput) => {
      const prompt = workerSessionStart(config.workerId);
      const launch = agent.launch({ config, prompt, configDir: io.configDir, home: io.home });
      for (const file of launch.files) {
        io.writePrivate(file.path, file.update(io.readFile(file.path)));
      }
      const proc = spawnProcess([...launch.cmd], {
        cwd: config.cwd,
        env: { ...io.env, ...launch.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code] = await Promise.all([
        proc.exited,
        pump("stdout", proc.stdout, onOutput),
        pump("stderr", proc.stderr, onOutput),
      ]);
      return code;
    },
  };
};

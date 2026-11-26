import { errorMessage } from "./logger.ts";
import { type Killable, killProcessGroup } from "./process-group.ts";

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when git ran past this many milliseconds and was killed. */
  readonly timedOutMs?: number;
}

/** Runs `git` with `args`. Never rejects: a git that can't start resolves with code 127. */
export type Git = (
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) => Promise<GitResult>;

/**
 * The real `git`. Each command runs in its own process group, so one that runs past `timeoutMs`
 * is killed together with the remote helper it started, and its output can still be read to
 * the end. `stopAll` kills every command still running, for when the Watcher itself stops.
 */
export const gitRunner = (options: { readonly timeoutMs: number }) => {
  const running = new Set<Killable>();
  const run: Git = async (args, { cwd, env }) => {
    let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
    try {
      proc = Bun.spawn(["git", ...args], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
    } catch (e) {
      return { code: 127, stdout: "", stderr: errorMessage(e) };
    }
    running.add(proc);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc);
    }, options.timeoutMs);
    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, stdout, stderr, ...(timedOut ? { timedOutMs: options.timeoutMs } : {}) };
    } finally {
      clearTimeout(timer);
      running.delete(proc);
    }
  };
  return {
    run,
    stopAll: () => {
      for (const proc of running) killProcessGroup(proc);
    },
  };
};

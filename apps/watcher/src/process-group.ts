/** A process the Watcher started, as Bun's `Subprocess` has it. */
export interface Killable {
  readonly pid: number;
  readonly kill: (signal: "SIGKILL") => void;
}

/**
 * Kills `proc` and everything in its POSIX process group, which it leads when it was started
 * `detached`: the tools an agent launched, or the remote helper `git` runs. A process that leads
 * no group (or a platform without them) is killed alone.
 */
export const killProcessGroup = (proc: Killable): void => {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
};

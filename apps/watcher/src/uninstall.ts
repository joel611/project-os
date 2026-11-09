import { join } from "node:path";
import { piMcpPath, withoutPiServer } from "./agents.ts";

export const PACKAGE_UNINSTALL: readonly string[] = ["bun", "remove", "-g", "@project-os/watcher"];

export interface UninstallIo {
  /** The Watcher's private dir (`~/.config/project-os`): credentials and the Claude MCP file. */
  readonly configDir: string;
  readonly home: string;
  readonly ownPid: number;
  readonly readFile: (path: string) => string | undefined;
  readonly writeFile: (path: string, contents: string) => void;
  readonly remove: (path: string) => void;
  readonly removeDirIfEmpty: (path: string) => void;
  readonly watcherPids: () => Promise<readonly number[]>;
  readonly kill: (pid: number) => void;
  readonly run: (cmd: readonly string[]) => Promise<number>;
  /** Asks the person to go ahead; false when they decline or there is nobody to ask. */
  readonly confirm: () => Promise<boolean>;
  readonly log: (message: string) => void;
}

/**
 * Undoes what the install script and `register` added to this computer: stops running Watchers,
 * removes the package, deletes the saved registration, and takes the Coordinator out of Pi's MCP
 * file. The Coordinator still lists the computer until someone runs /unregister-worker.
 * Resolves with the process exit code.
 */
export const uninstallWatcher = async (io: UninstallIo, options: { yes: boolean }) => {
  const files = ["watcher.json", "mcp.json"].map((file) => join(io.configDir, file));
  io.log("This will:");
  io.log("  - stop any running project-os-watcher");
  io.log("  - uninstall the package (" + PACKAGE_UNINSTALL.join(" ") + ")");
  io.log(`  - delete ${files.join(" and ")} (the registration secret, agent and model)`);
  io.log(`  - remove the project-os entry from ${piMcpPath(io.home)}, if there is one`);
  if (!options.yes && !(await io.confirm())) {
    io.log("Cancelled.");
    return 1;
  }

  for (const pid of await io.watcherPids()) if (pid !== io.ownPid) io.kill(pid);

  const piFile = piMcpPath(io.home);
  const existing = io.readFile(piFile);
  const cleaned = existing === undefined ? undefined : withoutPiServer(existing);
  if (cleaned !== undefined) io.writeFile(piFile, cleaned);

  if ((await io.run(PACKAGE_UNINSTALL)) !== 0) {
    io.log(`Warning: \`${PACKAGE_UNINSTALL.join(" ")}\` failed; remove the package by hand.`);
  }

  for (const file of files) io.remove(file);
  io.removeDirIfEmpty(io.configDir);

  io.log(
    "Removed. The Coordinator still lists this computer: run /workers, then /unregister-worker worker:<name> (add shared:True for a shared worker) in Discord.",
  );
  return 0;
};

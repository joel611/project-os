import { closeSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, type Logger } from "./logger.ts";
import type { RunSink } from "./run-log.ts";

/** One session's log file, open for appending. */
export interface SessionLogFile {
  readonly write: (text: string) => void;
  readonly close: () => void;
}

/** Opens the log file `<ticketId>/<name>`. Throws when it can't. */
export type OpenSessionLog = (ticketId: string, name: string) => SessionLogFile;

/** Session logs under `dir` (`<configDir>/logs/sessions`): folders `0700`, files `0600`. */
export const sessionLogFiles =
  (dir: string): OpenSessionLog =>
  (ticketId, name) => {
    const folder = join(dir, ticketId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const fd = openSync(join(folder, name), "a", 0o600);
    fchmodSync(fd, 0o600);
    return { write: (text) => void writeSync(fd, text), close: () => closeSync(fd) };
  };

/**
 * Writes a session's events to its own file, one JSON line each. A file that can't be opened or
 * written is logged once and given up on: the session goes on without it.
 */
export const sessionLogSink = (open: () => SessionLogFile, logger: Logger): RunSink => {
  let file: SessionLogFile | undefined;
  const giveUp = (what: string, e: unknown) => {
    logger.warn(`session log: could not ${what}: ${errorMessage(e)}`);
    const open = file;
    file = undefined;
    try {
      open?.close();
    } catch {
      // Already broken; nothing more to save.
    }
  };
  try {
    file = open();
  } catch (e) {
    giveUp("open it", e);
  }
  return {
    push: (event) => {
      try {
        file?.write(`${JSON.stringify(event)}\n`);
      } catch (e) {
        giveUp("write it", e);
      }
    },
    finish: async () => {
      try {
        file?.close();
        file = undefined;
      } catch (e) {
        giveUp("close it", e);
      }
    },
  };
};

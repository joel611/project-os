import { fchmodSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import pinoPretty from "pino-pretty";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A logger that appends info, warn and error messages to `sink`, like the default level. For tests. */
export const collectLogger = (sink: string[]): Logger => {
  const push = (message: string) => void sink.push(message);
  return { debug: () => {}, info: push, warn: push, error: push };
};

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Timestamped logger on stdout. A terminal gets colored one-line output; anything else
 * (Docker, a pipe) gets JSON lines with an ISO `time`. `verbose` adds the debug level. With
 * `file`, the same entries are also appended to it as JSON lines, readable by this user only.
 */
export const createLogger = (options: {
  readonly verbose: boolean;
  readonly pretty?: boolean;
  readonly file?: string;
}): Logger => {
  const pretty = options.pretty ?? Boolean(process.stdout.isTTY);
  const level = options.verbose ? "debug" : "info";
  const stdout = pretty
    ? pinoPretty({
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
        destination: process.stdout,
      })
    : process.stdout;
  const appendTo = (file: string) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, "a", 0o600);
    fchmodSync(fd, 0o600);
    return pino.destination({ fd, sync: true });
  };
  const base = pino(
    { level, base: null, timestamp: pino.stdTimeFunctions.isoTime },
    options.file
      ? pino.multistream([
          { level, stream: stdout },
          { level, stream: appendTo(options.file) },
        ])
      : stdout,
  );
  const at =
    (level: "debug" | "info" | "warn" | "error") => (message: string, fields?: LogFields) =>
      fields ? base[level](fields, message) : base[level](message);
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
};

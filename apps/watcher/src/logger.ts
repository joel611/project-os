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
 * (Docker, a pipe) gets JSON lines with an ISO `time`. `verbose` adds the debug level.
 */
export const createLogger = (options: {
  readonly verbose: boolean;
  readonly pretty?: boolean;
}): Logger => {
  const pretty = options.pretty ?? Boolean(process.stdout.isTTY);
  const base = pino(
    {
      level: options.verbose ? "debug" : "info",
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pretty
      ? pinoPretty({
          colorize: true,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
          ignore: "pid,hostname",
          destination: process.stdout,
        })
      : process.stdout,
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

import {
  RUN_CHUNK_MAX_EVENTS,
  type RunEvent,
  type RunUpload,
  sanitizeRunEvent,
} from "@project-os/contracts";
import { errorMessage, type Logger, silentLogger } from "./logger.ts";

/** Where a ticket's run log is uploaded: next to the Coordinator's MCP endpoint. */
export const runsUrl = (mcpUrl: string, ticketId: string): string =>
  `${mcpUrl.replace(/\/mcp\/?$/, "")}/tickets/${encodeURIComponent(ticketId)}/runs`;

/** The Coordinator's answer to an upload. `expected` comes with a 409: the chunk it wants next. */
export type PostResult =
  | { readonly ok: true; readonly nextSeq: number }
  | { readonly ok: false; readonly status: number; readonly expected?: number };

/** A saved upload that couldn't be delivered, for the next try. */
export interface SpooledUpload {
  readonly url: string;
  readonly upload: RunUpload;
}

export interface RunLogIo {
  /** Sends one chunk. Resolves with the Coordinator's answer; rejects when it can't be reached. */
  readonly post: (url: string, secret: string, upload: RunUpload) => Promise<PostResult>;
  /** Files of chunks still to deliver, in this device's private config directory. */
  readonly spool: {
    readonly write: (name: string, contents: string) => void;
    readonly list: () => ReadonlyArray<{ readonly name: string; readonly contents: string }>;
    readonly remove: (name: string) => void;
  };
  readonly newRunId: () => string;
  readonly now: () => Date;
  /** Values to mask exactly, besides the device secret (the environment's tokens and keys). */
  readonly secrets: ReadonlyArray<string>;
  /** How often events are sent while a session runs. Default 3 s. */
  readonly flushEveryMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Events held back from one flush at most; a bigger backlog goes out chunk by chunk. */
const FLUSH_AT = 100;
/** The most events written to the spool for one run; the newest are kept. */
const SPOOL_MAX_EVENTS = 5_000;
/** Tries (with growing pauses) to deliver the last chunk before the rest is spooled. */
const FINAL_ATTEMPTS = 3;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The Coordinator will never take this upload: unknown ticket, not ours, or malformed. */
const permanent = (status: number) => status === 400 || status === 403 || status === 404;

export interface RunRecorder {
  readonly runId: string;
  /** Adds an event; it goes out with the next flush. */
  readonly push: (event: RunEvent) => void;
  /** Sends everything recorded so far, then the exit code. Never throws. */
  readonly finish: (exitCode: number) => Promise<void>;
}

/**
 * Records one agent session and ships it to the Coordinator in the background: events are masked
 * (`sanitizeRunEvent`), batched, and uploaded as numbered chunks every few seconds. A failed
 * upload keeps its chunk and is tried again with the next flush, so a short outage loses nothing;
 * what is still undelivered when the session ends goes to the spool for the next poll to retry.
 * Run logging never makes the session fail.
 */
export const createRunRecorder = (options: {
  readonly io: RunLogIo;
  readonly url: string;
  readonly secret: string;
  readonly agent: string;
  readonly model?: string;
  readonly logger?: Logger;
}): RunRecorder => {
  const { io } = options;
  const logger = options.logger ?? silentLogger;
  const sleep = io.sleep ?? defaultSleep;
  const runId = io.newRunId();
  const startedAt = io.now().toISOString();
  const secrets = [options.secret, ...io.secrets];

  let buffer: RunEvent[] = [];
  /** The chunk being sent, kept as it was so a retry sends the same events under the same seq. */
  let inflight: RunEvent[] | undefined;
  let seq = 0;
  let finished: number | undefined;
  let gaveUp = false;
  let chain: Promise<unknown> = Promise.resolve();

  const upload = (events: RunEvent[]): RunUpload => ({
    runId,
    seq,
    agent: options.agent,
    ...(options.model === undefined ? {} : { model: options.model }),
    startedAt,
    events,
    ...(finished !== undefined && buffer.length === 0 ? { finished: { exitCode: finished } } : {}),
  });

  /** Sends chunks until nothing is left or one fails. True when everything was delivered. */
  const drain = async (): Promise<boolean> => {
    while (!gaveUp && (inflight !== undefined || buffer.length > 0 || finished !== undefined)) {
      const events = inflight ?? buffer.splice(0, RUN_CHUNK_MAX_EVENTS);
      inflight = events;
      const body = upload(events);
      let result: PostResult;
      try {
        result = await io.post(options.url, options.secret, body);
      } catch (e) {
        logger.debug(`run log: upload failed: ${errorMessage(e)}`, { runId, seq });
        return false;
      }
      if (result.ok) {
        inflight = undefined;
        seq = result.nextSeq;
        if (body.finished) {
          finished = undefined;
          return true;
        }
        if (buffer.length === 0) return true;
        continue;
      }
      if (result.status === 409 && result.expected !== undefined && result.expected !== seq) {
        // The Coordinator has this chunk already (a lost answer) or wants an earlier one.
        if (result.expected === seq + 1 && events.length > 0) {
          inflight = undefined;
          seq = result.expected;
          continue;
        }
        logger.warn("run log: chunk numbering out of step; giving up on this run's log", {
          runId,
        });
        gaveUp = true;
        return true;
      }
      if (permanent(result.status)) {
        logger.warn(`run log: the Coordinator refused it (${result.status}); not kept`, { runId });
        gaveUp = true;
        return true;
      }
      logger.debug(`run log: upload answered ${result.status}`, { runId, seq });
      return false;
    }
    return true;
  };

  const flush = (): Promise<boolean> => {
    const next = chain.then(drain, drain);
    chain = next.catch(() => false);
    return next.catch(() => false);
  };

  const timer = setInterval(() => void flush(), io.flushEveryMs ?? 3_000);
  // A pending flush must not keep a finished Watcher alive.
  (timer as { unref?: () => void }).unref?.();

  const spoolRest = () => {
    const rest = [...(inflight ?? []), ...buffer];
    const events = rest.slice(-SPOOL_MAX_EVENTS);
    const uploads: SpooledUpload[] = [];
    for (let i = 0; i < Math.max(events.length, 1); i += RUN_CHUNK_MAX_EVENTS) {
      const slice = events.slice(i, i + RUN_CHUNK_MAX_EVENTS);
      const last = i + RUN_CHUNK_MAX_EVENTS >= events.length;
      uploads.push({
        url: options.url,
        upload: {
          runId,
          seq: seq + uploads.length,
          agent: options.agent,
          ...(options.model === undefined ? {} : { model: options.model }),
          startedAt,
          events: slice,
          ...(last && finished !== undefined ? { finished: { exitCode: finished } } : {}),
        },
      });
    }
    io.spool.write(`${runId}.json`, JSON.stringify(uploads));
    logger.warn("run log: Coordinator unreachable; saved the rest to send later", { runId });
  };

  return {
    runId,
    push: (event) => {
      if (gaveUp) return;
      buffer.push(sanitizeRunEvent(event, secrets));
      if (buffer.length >= FLUSH_AT) void flush();
    },
    finish: async (exitCode) => {
      clearInterval(timer);
      finished = exitCode;
      for (let attempt = 1; attempt <= FINAL_ATTEMPTS; attempt++) {
        if (await flush()) return;
        if (attempt < FINAL_ATTEMPTS) await sleep(1_000 * attempt ** 2);
      }
      try {
        if (!gaveUp) spoolRest();
      } catch (e) {
        logger.warn(`run log: could not save the rest: ${errorMessage(e)}`, { runId });
      }
    },
  };
};

/**
 * Delivers what earlier sessions could not: each spooled file is sent in order and removed once
 * the Coordinator has it, or has said it never will (the ticket is gone). A file that still
 * can't be delivered stays for the next time.
 */
export const resendSpooled = async (
  io: Pick<RunLogIo, "post" | "spool">,
  secret: string,
  logger: Logger = silentLogger,
): Promise<number> => {
  let delivered = 0;
  for (const file of io.spool.list()) {
    let uploads: SpooledUpload[];
    try {
      uploads = JSON.parse(file.contents) as SpooledUpload[];
    } catch {
      io.spool.remove(file.name);
      continue;
    }
    let done = true;
    for (const { url, upload } of uploads) {
      try {
        const result = await io.post(url, secret, upload);
        // 409: the Coordinator has this chunk; carry on with the next.
        if (result.ok || result.status === 409 || permanent(result.status)) continue;
        done = false;
      } catch {
        done = false;
      }
      if (!done) break;
    }
    if (done) {
      io.spool.remove(file.name);
      delivered++;
    } else {
      logger.debug("run log: spooled upload still not delivered", { file: file.name });
    }
  }
  return delivered;
};

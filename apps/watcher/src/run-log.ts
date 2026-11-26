import {
  RUN_CHUNK_MAX_EVENTS,
  type RunEvent,
  type RunUpload,
  sanitizeRunEvent,
} from "@project-os/contracts";
import { errorMessage, type Logger, silentLogger } from "./logger.ts";

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
  /** How often events are sent while a session runs. */
  readonly flushEveryMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Events held back from one flush at most; a bigger backlog goes out chunk by chunk. */
const FLUSH_AT = 100;
/** The most events written to the spool for one run; the newest are kept. */
const SPOOL_MAX_EVENTS = 5_000;
/** Tries (with growing pauses) to deliver the last chunk before the rest is spooled. */
const FINAL_ATTEMPTS = 3;

/** The Coordinator will never take this upload: unknown ticket, not ours, or malformed. */
const permanent = (status: number) => status === 400 || status === 403 || status === 404;

/** Where a session's events go. Each one gets every event, already masked. */
export interface RunSink {
  readonly push: (event: RunEvent) => void;
  /** Writes out everything pushed so far, then the exit code. Never throws. */
  readonly finish: (exitCode: number) => Promise<void>;
}

export interface RunRecorder extends RunSink {
  readonly runId: string;
}

/**
 * One agent session's event stream. Each event is masked once (`sanitizeRunEvent`, with
 * `secrets`), then handed to every sink, so the session's own log file and the upload hold the
 * same events.
 */
export const createRunRecorder = (options: {
  readonly runId: string;
  readonly secrets: readonly string[];
  readonly sinks: readonly RunSink[];
}): RunRecorder => ({
  runId: options.runId,
  push: (event) => {
    const masked = sanitizeRunEvent(event, options.secrets);
    for (const sink of options.sinks) sink.push(masked);
  },
  finish: async (exitCode) => {
    await Promise.all(options.sinks.map((sink) => sink.finish(exitCode)));
  },
});

/**
 * Ships a session's events to the Coordinator in the background: batched, and uploaded as
 * numbered chunks every few seconds. A failed upload keeps its chunk and is tried again with the
 * next flush, so a short outage loses nothing; what is still undelivered when the session ends
 * goes to the spool for the next poll to retry. Run logging never makes the session fail.
 */
export const runUploadSink = (options: {
  readonly io: RunLogIo;
  readonly runId: string;
  readonly startedAt: string;
  readonly url: string;
  readonly secret: string;
  readonly agent: string;
  readonly model?: string;
  readonly assignedAt?: string;
  readonly logger?: Logger;
}): RunSink => {
  const { io, runId, startedAt } = options;
  const logger = options.logger ?? silentLogger;

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
    ...(options.assignedAt && { assignedAt: options.assignedAt }),
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

  // `drain` never rejects (an upload that throws is a failed upload), so the chain never breaks.
  const flush = (): Promise<boolean> => {
    const next = chain.then(drain);
    chain = next;
    return next;
  };

  const timer = setInterval(() => void flush(), io.flushEveryMs);
  // A pending flush must not keep a finished Watcher alive.
  (timer as { unref?: () => void }).unref?.();

  const spoolRest = (exitCode: number) => {
    // A failed upload always leaves its chunk in `inflight`.
    const rest = [...inflight!, ...buffer];
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
          ...(last ? { finished: { exitCode } } : {}),
        },
      });
    }
    io.spool.write(`${runId}.json`, JSON.stringify(uploads));
    logger.warn("run log: Coordinator unreachable; saved the rest to send later", { runId });
  };

  return {
    push: (event) => {
      if (gaveUp) return;
      buffer.push(event);
      if (buffer.length >= FLUSH_AT) void flush();
    },
    finish: async (exitCode) => {
      clearInterval(timer);
      finished = exitCode;
      for (let attempt = 1; attempt <= FINAL_ATTEMPTS; attempt++) {
        if (await flush()) return;
        if (attempt < FINAL_ATTEMPTS) await io.sleep(1_000 * attempt ** 2);
      }
      try {
        spoolRest(exitCode);
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
      // 409: the Coordinator has this chunk; carry on with the next.
      const handled = await io.post(url, secret, upload).then(
        (result) => result.ok || result.status === 409 || permanent(result.status),
        () => false,
      );
      if (!handled) {
        done = false;
        break;
      }
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

import {
  RUN_CHUNK_MAX_EVENTS,
  type Requester,
  type Run,
  type RunEvent,
  type RunTranscript,
  type RunUpload,
  SAFE_RUN_ID,
  sanitizeRunEvent,
} from "@project-os/contracts";
import { Effect } from "effect";
import {
  InvalidTransition,
  RunNotFound,
  RunOutOfOrder,
  RunRejected,
  runChunkKey,
  type Ticket,
  TicketNotFound,
  WorkerUnauthorized,
} from "../../domain/index.ts";
import { AssetStore, Clock, RunRepository, TicketRepository } from "../ports/index.ts";
import { audit, type AuditActor } from "./audit.ts";
import { recordForceStop } from "./ticket-lifecycle.ts";
import type { McpCaller } from "./personal-workers.ts";

/** Most bytes of transcript kept for one run. Beyond it later events are dropped. */
export const DEFAULT_RUN_MAX_BYTES = 20 * 1024 * 1024;

/** How long transcripts are kept when `RUN_LOG_RETENTION_DAYS` is unset. */
export const DEFAULT_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RunLogConfig {
  /** Transcript bytes kept per run. Default 20 MB. */
  readonly maxBytes?: number | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();

/** A chunk's events; a damaged line costs that line only. */
const parseChunk = (text: string): RunEvent[] =>
  text.split("\n").flatMap((line) => {
    if (line === "") return [];
    try {
      return [JSON.parse(line) as RunEvent];
    } catch {
      return [];
    }
  });

const isSame = (a: Requester | null, b: Requester) =>
  a !== null && a.channelType === b.channelType && a.id === b.id;

const auditRun = (ticket: Ticket, run: Run, action: "run_started" | "run_finished", at: string) =>
  audit({
    kind: "ticket",
    action,
    actor: { type: "worker", id: run.workerId },
    projectId: ticket.projectId,
    ticketId: ticket.id,
    workerId: run.workerId,
    summary:
      action === "run_started"
        ? `${run.agent} session started on "${ticket.title}"`
        : `${run.agent} session ${run.status} (exit ${run.exitCode}) on "${ticket.title}"`,
    payload: {
      title: ticket.title,
      status: ticket.status,
      workerType: ticket.workerType,
      workerId: ticket.workerId,
      runId: run.id,
      agent: run.agent,
      ...(run.exitCode === null ? {} : { exitCode: run.exitCode }),
    },
    at,
    dedupeKey: `${action}:${run.id}`,
  });

/**
 * Stores the next chunk of a run: masks secrets, writes the events to file storage and updates
 * the run's summary. `seq` must be the chunk the run expects (`RunOutOfOrder` otherwise); a chunk
 * sent twice is stored once. The caller has already checked who may write to the ticket.
 */
const storeChunk = (
  ticket: Ticket,
  workerId: string,
  upload: RunUpload,
  options: { readonly secrets?: ReadonlyArray<string>; readonly maxBytes?: number | undefined },
) =>
  Effect.gen(function* () {
    if (!SAFE_RUN_ID.test(upload.runId)) {
      return yield* new RunRejected({
        message: "runId must be 8 to 64 letters, digits, - or _.",
      });
    }
    if (upload.seq < 0 || upload.events.length > RUN_CHUNK_MAX_EVENTS) {
      return yield* new RunRejected({
        message: `seq must be 0 or more, with at most ${RUN_CHUNK_MAX_EVENTS} events per chunk.`,
      });
    }
    const runs = yield* RunRepository;
    const store = yield* AssetStore;
    const now = (yield* Effect.flatMap(Clock, (c) => c.now)).toISOString();
    const existing = yield* runs.get(upload.runId);
    if (existing && (existing.ticketId !== ticket.id || existing.workerId !== workerId)) {
      return yield* new RunRejected({ message: "That run id belongs to another session." });
    }
    let run: Run = existing ?? {
      id: upload.runId,
      ticketId: ticket.id,
      workerId,
      agent: upload.agent.slice(0, 40),
      model: upload.model?.slice(0, 120) ?? null,
      status: "running",
      exitCode: null,
      startedAt: upload.startedAt ?? now,
      endedAt: null,
      eventCount: 0,
      errorCount: 0,
      bytes: 0,
      nextSeq: 0,
      truncated: false,
      expired: false,
    };
    if (upload.seq > run.nextSeq) {
      return yield* new RunOutOfOrder({ runId: run.id, expected: run.nextSeq });
    }
    // A chunk already stored (a retry after a lost response) is not stored again.
    const fresh = upload.seq === run.nextSeq && upload.events.length > 0 && !run.endedAt;
    if (fresh) {
      const maxBytes = options.maxBytes ?? DEFAULT_RUN_MAX_BYTES;
      let events: ReadonlyArray<RunEvent> = upload.events.map((e) =>
        sanitizeRunEvent(e, options.secrets ?? []),
      );
      let body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      let truncated = run.truncated;
      if (truncated) {
        events = [];
      } else if (run.bytes + encoder.encode(body).length > maxBytes) {
        truncated = true;
        events = [
          {
            at: now,
            type: "lifecycle",
            text: `Transcript cut here: the ${Math.round(maxBytes / 1024 / 1024)} MB limit per run was reached.`,
          },
        ];
        body = JSON.stringify(events[0]) + "\n";
      }
      if (events.length > 0) {
        const bytes = encoder.encode(body);
        yield* store.put({
          key: runChunkKey(ticket.id, run.id, run.nextSeq),
          body: streamOf(bytes),
          contentType: "application/x-ndjson",
          size: bytes.length,
          maxBytes: bytes.length,
        });
        run = {
          ...run,
          nextSeq: run.nextSeq + 1,
          eventCount: run.eventCount + events.length,
          errorCount: run.errorCount + events.filter((e) => e.type === "error").length,
          bytes: run.bytes + bytes.length,
          truncated,
        };
      } else {
        run = { ...run, truncated };
      }
    }
    const finishing = upload.finished !== undefined && run.endedAt === null;
    if (finishing) {
      run = {
        ...run,
        status: upload.finished!.exitCode === 0 ? "succeeded" : "failed",
        exitCode: upload.finished!.exitCode,
        endedAt: now,
      };
    }
    const assignedAt =
      ticket.workerType === "local" &&
      (ticket.status === "assigned" || ticket.status === "in_progress") &&
      upload.assignedAt === ticket.assignedAt &&
      !upload.finished
        ? ticket.assignedAt
        : null;
    yield* runs.save(run, assignedAt);
    if (existing === undefined) yield* auditRun(ticket, run, "run_started", run.startedAt);
    if (finishing) yield* auditRun(ticket, run, "run_finished", now);
    return run;
  });

export const forceStopRun = (ticketId: string, runId: string, by: AuditActor) =>
  Effect.gen(function* () {
    const ticket = yield* (yield* TicketRepository).get(ticketId);
    const runs = yield* RunRepository;
    const run = yield* runs.get(runId);
    if (!run || run.ticketId !== ticketId) return yield* new RunNotFound({ runId });
    const at = (yield* Effect.flatMap(Clock, (c) => c.now)).toISOString();
    if (!(yield* runs.requestStop(ticketId, runId, at))) {
      return yield* new InvalidTransition({ ticketId, from: ticket.status, to: "stopped" });
    }
    yield* recordForceStop(ticket, runId, by, at);
    return { ...run, status: "stopped", endedAt: at } satisfies Run;
  });

/** The owning Watcher can still read its signal after the ticket is assigned again. */
export const readRunStopSignal = (ticketId: string, runId: string, workerId: string) =>
  Effect.gen(function* () {
    const run = yield* (yield* RunRepository).get(runId);
    if (!run || run.ticketId !== ticketId || run.workerId !== workerId) {
      return yield* new RunNotFound({ runId });
    }
    return { stop: run.status === "stopped" };
  });

/**
 * A Worker's upload of its session's next chunk (`POST /tickets/:id/runs`). Only the worker the
 * ticket is assigned to may write to it. A worker that never finishes its run leaves it `running`.
 */
export const ingestRun = (
  ticketId: string,
  caller: Pick<McpCaller, "id">,
  upload: RunUpload,
  config: RunLogConfig = {},
) =>
  Effect.gen(function* () {
    const ticket = yield* (yield* TicketRepository).get(ticketId);
    if (ticket.workerId !== caller.id) {
      return yield* new WorkerUnauthorized({
        workerId: caller.id,
        message: "This ticket isn't assigned to this worker.",
      });
    }
    return yield* storeChunk(ticket, caller.id, upload, { maxBytes: config.maxBytes });
  });

/** What a sandbox launcher reports when a session ends. */
export interface SandboxRun {
  readonly ticketId: string;
  readonly workerId: string;
  readonly agent: string;
  readonly model: string;
  readonly startedAt: string;
  readonly exitCode: number;
  /** Everything the session printed (stdout and stderr together). */
  readonly output: string;
  /** Values that must not appear in the stored output (the session's tokens, API keys). */
  readonly secrets: ReadonlyArray<string>;
}

/**
 * Stores a sandbox session's output as a run: one `output` event per line, then the exit. A
 * sandbox hands the Coordinator its whole output at the end, so this has no caller to
 * authenticate: the launcher that started the session is the source.
 */
export const recordSandboxRun = (input: SandboxRun, config: RunLogConfig = {}) =>
  Effect.gen(function* () {
    const ticket = yield* (yield* TicketRepository).get(input.ticketId);
    const runId = `${input.workerId}-${Date.parse(input.startedAt).toString(36)}`.slice(0, 64);
    const at = (yield* Effect.flatMap(Clock, (c) => c.now)).toISOString();
    const lines = input.output.split(/\r?\n/).filter((line) => line.trim() !== "");
    const events: RunEvent[] = [
      ...lines.map((text): RunEvent => ({ at, type: "output", text })),
      {
        at,
        type: input.exitCode === 0 ? "lifecycle" : "error",
        text: `Session exited with code ${input.exitCode}.`,
      },
    ];
    let seq = 0;
    for (let i = 0; i < events.length; i += RUN_CHUNK_MAX_EVENTS) {
      const slice = events.slice(i, i + RUN_CHUNK_MAX_EVENTS);
      const last = i + RUN_CHUNK_MAX_EVENTS >= events.length;
      yield* storeChunk(
        ticket,
        input.workerId,
        {
          runId,
          seq: seq++,
          agent: input.agent,
          model: input.model,
          startedAt: input.startedAt,
          events: slice,
          ...(last ? { finished: { exitCode: input.exitCode } } : {}),
        },
        { secrets: input.secrets, maxBytes: config.maxBytes },
      );
    }
  });

/**
 * A ticket's runs, oldest first. With `requester`, only if that person asked for the ticket
 * (`TicketNotFound` otherwise, so someone else's ticket looks like a missing one).
 */
export const listTicketRuns = (ticketId: string, requester?: Requester) =>
  Effect.gen(function* () {
    const ticket = yield* (yield* TicketRepository).get(ticketId);
    if (requester && !isSame(ticket.requester, requester)) {
      return yield* new TicketNotFound({ ticketId });
    }
    return yield* (yield* RunRepository).listByTicket(ticketId);
  });

/** One run with its transcript, under the same access rule as `listTicketRuns`. */
export const readTicketRun = (ticketId: string, runId: string, requester?: Requester) =>
  Effect.gen(function* () {
    yield* listTicketRuns(ticketId, requester);
    const run = yield* (yield* RunRepository).get(runId);
    if (!run || run.ticketId !== ticketId) return yield* new RunNotFound({ runId });
    const store = yield* AssetStore;
    const events: RunEvent[] = [];
    if (!run.expired) {
      for (let seq = 0; seq < run.nextSeq; seq++) {
        const object = yield* store.get(runChunkKey(ticketId, runId, seq));
        if (!object) continue;
        const text = decoder.decode(
          yield* Effect.promise(() => new Response(object.body).arrayBuffer()),
        );
        events.push(...parseChunk(text));
      }
    }
    return { run, events } satisfies RunTranscript;
  });

/** Deletes transcripts older than the window (their summaries stay). Returns how many. */
export const pruneRuns = (retentionMs: number) =>
  Effect.gen(function* () {
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    const runs = yield* RunRepository;
    const store = yield* AssetStore;
    let pruned = 0;
    for (const run of yield* runs.listStoredBefore(cutoff)) {
      // A failed delete leaves the run as it is, to be tried again on the next sweep.
      const removed = yield* Effect.forEach(
        Array.from({ length: run.nextSeq }, (_, seq) => seq),
        (seq) => store.remove(runChunkKey(run.ticketId, run.id, seq)),
        { discard: true },
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!removed) continue;
      yield* runs.save({ ...run, expired: true });
      pruned++;
    }
    return pruned;
  });

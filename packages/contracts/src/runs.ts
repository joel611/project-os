import { Schema } from "effect";

/**
 * Run logs: what an agent did in one session on a Ticket, shipped back to the Coordinator so a
 * run can be debugged afterwards. A Watcher (or a sandbox launcher) records one `Run` per agent
 * session and uploads its `RunEvent`s in numbered chunks.
 */

export const RUN_EVENT_TYPES = [
  "lifecycle",
  "message",
  "tool_call",
  "tool_result",
  "output",
  "error",
] as const;
export const RunEventType = Schema.Literals(RUN_EVENT_TYPES);
export type RunEventType = typeof RunEventType.Type;

/** Longest `text` one event keeps; longer text is cut and the event marked `truncated`. */
export const RUN_EVENT_TEXT_MAX = 8_000;
/** Most events in one upload. */
export const RUN_CHUNK_MAX_EVENTS = 500;

/** One thing that happened in a session, normalized across agents. */
export const RunEvent = Schema.Struct({
  at: Schema.String,
  type: RunEventType,
  text: Schema.String,
  /** The tool a `tool_call` / `tool_result` is about. */
  tool: Schema.optionalKey(Schema.String),
  /** `text` was cut at `RUN_EVENT_TEXT_MAX`. */
  truncated: Schema.optionalKey(Schema.Boolean),
});
export type RunEvent = typeof RunEvent.Type;

/** A run id the uploader makes up: letters, digits, `-` and `_`, so it is safe in a storage key. */
export const SAFE_RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** How a session ended. */
export const RunFinish = Schema.Struct({
  exitCode: Schema.Finite,
});
export type RunFinish = typeof RunFinish.Type;

/** `POST /tickets/:id/runs`: the next chunk of a run, with `finished` on the last one. */
export const RunUpload = Schema.Struct({
  runId: Schema.String,
  /** 0 for the first chunk; each next one is `seq + 1`. Resending a seq is safe. */
  seq: Schema.Int,
  agent: Schema.String,
  model: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.String),
  /** The Watcher's assignment timestamp; present only for sessions that poll for stop signals. */
  assignedAt: Schema.optionalKey(Schema.String),
  events: Schema.Array(RunEvent),
  finished: Schema.optionalKey(RunFinish),
});
export type RunUpload = typeof RunUpload.Type;

export const RUN_STATUSES = ["running", "succeeded", "failed", "stopped"] as const;
export const RunStatus = Schema.Literals(RUN_STATUSES);
export type RunStatus = typeof RunStatus.Type;

/** One session's summary. The transcript itself is kept in file storage, in chunks. */
export const Run = Schema.Struct({
  id: Schema.String,
  ticketId: Schema.String,
  workerId: Schema.String,
  agent: Schema.String,
  model: Schema.NullOr(Schema.String),
  status: RunStatus,
  stoppable: Schema.optionalKey(Schema.Boolean),
  exitCode: Schema.NullOr(Schema.Finite),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  eventCount: Schema.Finite,
  errorCount: Schema.Finite,
  bytes: Schema.Finite,
  /** The next chunk number expected; also how many chunks are stored. */
  nextSeq: Schema.Finite,
  /** The size limit was hit: later events were dropped. */
  truncated: Schema.Boolean,
  /** The transcript was deleted by retention; this summary stays. */
  expired: Schema.Boolean,
});
export type Run = typeof Run.Type;

/** The 200 answer to a `RunUpload`: what the Coordinator has of the run now. */
export interface RunUploadAccepted {
  readonly runId: string;
  readonly nextSeq: Run["nextSeq"];
  readonly truncated: Run["truncated"];
  readonly status: RunStatus;
}

/** The 409 answer to a `RunUpload` that skips ahead: `expected` is the chunk wanted next. */
export interface RunUploadOutOfOrder {
  readonly error: "RunOutOfOrder";
  readonly expected: number;
}

/** `GET /tickets/:id/runs/:runId`. */
export interface RunTranscript {
  readonly run: Run;
  readonly events: ReadonlyArray<RunEvent>;
}

/** Placeholder a masked secret becomes. */
export const REDACTED = "[REDACTED]";

/** A secret shape and what it is replaced with (`$1` keeps a leading key or scheme). */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization headers and bare bearer tokens.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // `token=…`, `"api_key": "…"`, `password: …` and the like; the key stays so the log says what.
  [
    /\b((?:[a-z]+_)?(?:token|secret|password|passwd|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi,
    `$1${REDACTED}`,
  ],
  // GitHub, Google OAuth, Slack, OpenAI/OpenRouter/Anthropic style keys.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  // Discord bot tokens and JSON Web Tokens.
  [/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
];

/** Shortest value that is masked on its own: shorter ones would mask ordinary words. */
const MIN_SECRET_LENGTH = 8;

/** `text` with every pattern-matched secret and every known `secrets` value masked. */
export const redactSecrets = (text: string, secrets: ReadonlyArray<string> = []): string => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
};

/** The event with secrets masked in its text and the text clipped to `RUN_EVENT_TEXT_MAX`. */
export const sanitizeRunEvent = (
  event: RunEvent,
  secrets: ReadonlyArray<string> = [],
): RunEvent => {
  const masked = redactSecrets(event.text, secrets);
  const cut = masked.length > RUN_EVENT_TEXT_MAX;
  return {
    at: event.at,
    type: event.type,
    text: cut ? masked.slice(0, RUN_EVENT_TEXT_MAX) : masked,
    ...(event.tool === undefined ? {} : { tool: redactSecrets(event.tool, secrets).slice(0, 200) }),
    ...(cut || event.truncated ? { truncated: true } : {}),
  };
};

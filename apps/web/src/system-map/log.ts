import type {
  ActivityTicket,
  ChannelType,
  TicketEvent,
  TicketStatus,
  WorkerType,
} from "@project-os/contracts";
import { identityOf, ticketLabel, type Identity } from "./feed.ts";
import { WORKER_LABEL } from "./iso.ts";

/** Which part of the system a log line is about; sets its dot colour. */
export type LogTone = ChannelType | "coordinator" | "worker" | "ok" | "failed";

/** Plain text, a ticket id or tool name in code, or a person with their avatar. */
export type LogPart = string | { readonly code: string } | { readonly who: Identity };

export interface LogLine {
  readonly id: string;
  readonly at: string;
  readonly tone: LogTone;
  readonly parts: ReadonlyArray<LogPart>;
}

const CHANNEL_NAME: Readonly<Record<ChannelType, string>> = {
  discord: "on Discord",
  email: "by email",
  chat: "in chat",
};

/** "Local computer (w1)", "Local computer" for any worker of that type, or just the id. */
export const workerName = (id: string | null | undefined, type: WorkerType | null | undefined) =>
  id ? (type ? `${WORKER_LABEL[type]} (${id})` : id) : type ? WORKER_LABEL[type] : "a worker";

const workerOf = (t: ActivityTicket | undefined): string => workerName(t?.workerId, t?.workerType);

type Sender = { id: string; name?: string; email?: string };

const quote = (body: string) => (body ? `: “${body}”` : "");

const WORKER_VERB: Partial<Record<TicketEvent["type"], string>> = {
  status_update: "posted a status update on ",
  comment: "commented on ",
  result: "posted the result for ",
  error: "reported an error on ",
};

/** The log lines one TicketEvent stands for, oldest first. */
export const eventLines = (e: TicketEvent, t: ActivityTicket | undefined): LogLine[] => {
  const ticket = { code: ticketLabel(e.ticketId) };
  const line = (suffix: string, tone: LogTone, parts: LogPart[]): LogLine => ({
    id: `${e.id}:${suffix}`,
    at: e.createdAt,
    tone,
    parts,
  });
  const p = e.payload as { sender?: Sender; channelType?: ChannelType } | null;
  const channel = p?.channelType ?? t?.origin?.channelType;
  const who = p?.sender && channel ? identityOf({ channelType: channel, sender: p.sender }) : null;

  switch (e.type) {
    case "created":
      return [
        line("message", who?.channel ?? "coordinator", [
          ...(who ? [{ who }, ` ${CHANNEL_NAME[who.channel]}`] : ["A message"]),
          quote(e.body),
        ]),
        ...(t?.intent
          ? [line("intent", "coordinator", ["Jev classified it as ", { code: t.intent }])]
          : []),
        line("ticket", "coordinator", ["Created ticket ", ticket, " (open)"]),
      ];
    case "assigned": {
      const payload = e.payload as { workerId?: string | null; workerType?: WorkerType } | null;
      return [
        line("assigned", "coordinator", [
          "Marked ",
          ticket,
          ` assigned to ${workerName(payload?.workerId, payload?.workerType)}. Waiting for it to pull.`,
        ]),
      ];
    }
    case "follow_up":
      return [
        line("message", who?.channel ?? "coordinator", [
          ...(who ? [{ who }, " followed up on "] : ["Follow-up on "]),
          ticket,
          quote(e.body),
        ]),
        line("appended", "coordinator", [
          "Appended a ",
          { code: "follow_up" },
          " event to ",
          ticket,
          ". The worker sees it on its next ",
          { code: "ticket_get" },
          ".",
        ]),
      ];
    default: {
      const verb = e.actor === "worker" ? WORKER_VERB[e.type] : undefined;
      if (verb)
        return [
          line(e.type, e.type === "error" ? "failed" : "worker", [
            `${e.actorId && e.actorId !== t?.workerId ? e.actorId : workerOf(t)} ${verb}`,
            ticket,
            e.body ? `: ${e.body}` : "",
          ]),
        ];
      return [line(e.type, "coordinator", [ticket, ` ${e.body || e.type}`])];
    }
  }
};

/**
 * Log lines for status changes that have no TicketEvent of their own (claim, completion, …),
 * seen between two reads of the feed.
 */
export const transitionLines = (t: ActivityTicket, before: TicketStatus | undefined): LogLine[] => {
  const ticket = { code: ticketLabel(t.id) };
  const worker = workerOf(t);
  const lines: LogLine[] = [];
  const pending = before === undefined || before === "open" || before === "assigned";
  if (pending && t.startedAt && t.status !== "assigned")
    lines.push({
      id: `${t.id}:claimed`,
      at: t.startedAt,
      tone: "worker",
      parts: [`${worker} claimed `, ticket, ", now in progress"],
    });
  if (t.status === before) return lines;
  const at = t.completedAt ?? t.updatedAt;
  const who = t.origin ? identityOf(t.origin) : null;
  switch (t.status) {
    case "completed":
      lines.push({
        id: `${t.id}:completed`,
        at,
        tone: "ok",
        parts: [ticket, ` completed by ${worker}`],
      });
      if (t.replyChannel)
        lines.push({
          id: `${t.id}:reply`,
          at,
          tone: t.replyChannel,
          parts: [
            "Coordinator replied",
            ...(who ? [" to ", { who }] : []),
            ` ${CHANNEL_NAME[t.replyChannel]}`,
          ],
        });
      break;
    case "failed":
      lines.push({
        id: `${t.id}:failed`,
        at,
        tone: "failed",
        parts: [ticket, ` failed${t.error ? `: ${t.error}` : ""}`],
      });
      break;
    case "blocked":
      lines.push({ id: `${t.id}:blocked`, at, tone: "worker", parts: [ticket, ` is blocked`] });
      break;
    case "cancelled":
      lines.push({
        id: `${t.id}:cancelled`,
        at,
        tone: "coordinator",
        parts: [ticket, " was cancelled"],
      });
      break;
  }
  return lines;
};

/** Newest first; lines at the same moment keep the order they happened in, newest on top. */
export const newestFirst = (lines: ReadonlyArray<LogLine>): LogLine[] =>
  lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => b.line.at.localeCompare(a.line.at) || b.i - a.i)
    .map(({ line }) => line);

import type {
  AuditEntry,
  AuditKind,
  RuntimeErrorAuditPayload,
  TicketAuditPayload,
} from "@project-os/contracts";
import { redactSecrets } from "@project-os/contracts";
import { Effect } from "effect";
import { AuditLogRepository, Clock, ProjectRepository } from "../ports/index.ts";

/** Longest window a report may cover, and the one it covers by default. */
export const REPORT_MAX_HOURS = 24 * 14;
export const REPORT_DEFAULT_HOURS = 24;

/** Pages of 200 read per kind, so a report stays one bounded read however busy the log is. */
const PAGES_PER_KIND = 5;
const PAGE_SIZE = 200;
/** Stack lines kept per distinct error. */
const STACK_LINES = 8;

export interface IncidentReportInput {
  /** Only this project's entries (and none of the org-only ones). Default: everything. */
  readonly projectId?: string;
  /** How far back to look. Default 24 hours, at most two weeks. */
  readonly hours?: number;
}

export interface IncidentReport {
  readonly filename: string;
  /** Markdown, ready to attach to a Discord message or a GitHub issue. */
  readonly markdown: string;
}

/** Entries of one kind newer than `since`, newest first, read a bounded number of pages deep. */
const recent = (kind: AuditKind, since: string, projectId: string | undefined) =>
  Effect.gen(function* () {
    const log = yield* AuditLogRepository;
    const found: AuditEntry[] = [];
    let before: number | undefined;
    for (let page = 0; page < PAGES_PER_KIND; page++) {
      const { entries, next } = yield* log.list({
        kind,
        limit: PAGE_SIZE,
        ...(projectId === undefined ? {} : { projectId }),
        ...(before === undefined ? {} : { before }),
      });
      for (const e of entries) if (e.at >= since) found.push(e);
      const oldest = entries.at(-1);
      if (next === null || oldest === undefined || oldest.at < since) break;
      before = next;
    }
    return found;
  });

/** One line, no markdown-breaking characters. */
const inline = (text: string) => text.replace(/\s+/g, " ").trim();

const fence = (text: string) => `\`\`\`text\n${text.replaceAll("```", "'''")}\n\`\`\``;

interface ErrorGroup {
  payload: RuntimeErrorAuditPayload;
  count: number;
  first: string;
  last: string;
  projectId: string | null;
}

/**
 * The incident report: what went wrong in the last `hours`, as one Markdown file a person can
 * post to the project's channel so a Worker can investigate. It lists the errors the Coordinator
 * raised (grouped by fingerprint), tickets that failed or blocked, Workers that went offline,
 * and failed digest and classifier runs. Everything is masked for secrets once more on the way
 * out, and it holds no message text, only ticket titles.
 */
export const incidentReport = (input: IncidentReportInput = {}) =>
  Effect.gen(function* () {
    if (input.projectId !== undefined) yield* (yield* ProjectRepository).get(input.projectId);
    const hours = Math.min(Math.max(1, input.hours ?? REPORT_DEFAULT_HOURS), REPORT_MAX_HOURS);
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const at = now.toISOString();

    const [errors, tickets, workers, digests, inbound] = yield* Effect.all([
      recent("runtime_error", since, input.projectId),
      recent("ticket", since, input.projectId),
      recent("worker", since, input.projectId),
      recent("digest_event", since, input.projectId),
      recent("inbound_event", since, input.projectId),
    ]);

    const groups = new Map<string, ErrorGroup>();
    for (const e of errors) {
      const payload = e.payload as RuntimeErrorAuditPayload;
      const seen = groups.get(payload.fingerprint);
      if (seen) {
        seen.count += 1;
        if (e.at < seen.first) seen.first = e.at;
        if (e.at > seen.last) seen.last = e.at;
        // Keep a stack if any occurrence has one.
        if (!seen.payload.stack && payload.stack) seen.payload = payload;
      } else {
        groups.set(payload.fingerprint, {
          payload,
          count: 1,
          first: e.at,
          last: e.at,
          projectId: e.projectId,
        });
      }
    }
    const failedTickets = tickets.filter((e) => {
      const status = (e.payload as TicketAuditPayload).status;
      return e.action === "status_changed" && (status === "failed" || status === "blocked");
    });
    const outages = workers.filter((e) => e.action === "went_offline");
    const digestFailures = digests.filter((e) => e.action === "failed");
    const classifyFailures = inbound.filter((e) => e.action === "classify_failed");

    const lines: string[] = [
      `# Incident report`,
      ``,
      `- Generated: ${at}`,
      `- Window: last ${hours} hour(s), since ${since}`,
      `- Scope: ${input.projectId === undefined ? "all projects" : `project ${input.projectId}`}`,
      `- Found: ${groups.size} distinct error(s), ${failedTickets.length} failed or blocked ticket event(s), ${outages.length} worker outage(s), ${digestFailures.length} digest failure(s), ${classifyFailures.length} classifier failure(s)`,
      ``,
      `Source: the Coordinator's audit log. Each hour an identical error is logged at most once, so counts show hours it happened in, not how often.`,
      ``,
      `## Errors the Coordinator raised`,
      ``,
    ];
    if (groups.size === 0) lines.push("None in this window.", "");
    for (const g of [...groups.values()].sort((a, b) => b.count - a.count)) {
      const p = g.payload;
      lines.push(
        `### ${inline(p.where)}: ${inline(p.name)}`,
        ``,
        `- Fingerprint: \`${p.fingerprint}\``,
        `- Hours with this error: ${g.count} (first ${g.first}, last ${g.last})`,
        `- Message: ${inline(p.message)}`,
        ``,
      );
      if (p.stack) lines.push(fence(p.stack.split("\n").slice(0, STACK_LINES).join("\n")), ``);
    }

    lines.push(`## Tickets that failed or blocked`, ``);
    if (failedTickets.length === 0) lines.push("None in this window.", "");
    for (const e of failedTickets) {
      const t = e.payload as TicketAuditPayload;
      lines.push(
        `- ${e.at} ticket \`${e.ticketId}\` "${inline(t.title)}" → ${t.status}${
          t.error ? `: ${inline(t.error)}` : t.reason ? `: ${inline(t.reason)}` : ""
        }${t.workerId ? ` (worker \`${t.workerId}\`)` : ""}`,
      );
    }
    if (failedTickets.length > 0) lines.push("");

    lines.push(`## Workers that went offline`, ``);
    if (outages.length === 0) lines.push("None in this window.", "");
    for (const e of outages) lines.push(`- ${e.at} ${inline(e.summary)}`);
    if (outages.length > 0) lines.push("");

    lines.push(`## Digest and classifier failures`, ``);
    if (digestFailures.length + classifyFailures.length === 0) {
      lines.push("None in this window.", "");
    }
    for (const e of [...digestFailures, ...classifyFailures]) {
      lines.push(
        `- ${e.at} ${e.kind === "digest_event" ? "digest" : "classifier"}: ${inline(e.summary)}`,
      );
    }

    const markdown = `${redactSecrets(lines.join("\n"))}\n`;
    return {
      filename: `incident-report-${at.slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}.md`,
      markdown,
    } satisfies IncidentReport;
  });

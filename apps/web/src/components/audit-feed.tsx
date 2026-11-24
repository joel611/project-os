import {
  AUDIT_KINDS,
  type AuditEntry,
  type AuditKind,
  type ChannelType,
  type ClassifiedAuditPayload,
  type Project,
  type TicketStatus,
} from "@project-os/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  BookOpenText,
  ChevronDown,
  Cpu,
  Download,
  OctagonAlert,
  KeyRound,
  MessageSquare,
  Ticket as TicketIcon,
} from "lucide-react";
import { useState } from "react";
import { api, describeError } from "@/api";
import { CHANNEL_META } from "@/components/source";
import { Empty, QueryError } from "@/components/states";
import { ToneDot } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { relativeTime, STATUS, type Tone } from "@/model";
import { SLOW_MS } from "@/polling";
import { useNow } from "@/use-now";

export const KIND_META: Readonly<
  Record<AuditKind, { readonly label: string; readonly Icon: typeof Cpu }>
> = {
  inbound_event: { label: "Inbound", Icon: MessageSquare },
  digest_event: { label: "Digest", Icon: BookOpenText },
  worker: { label: "Workers", Icon: Cpu },
  ticket: { label: "Tickets", Icon: TicketIcon },
  connection: { label: "Accounts", Icon: KeyRound },
  runtime_error: { label: "Errors", Icon: OctagonAlert },
};

const ACTION_LABEL: Readonly<Record<string, string>> = {
  received: "received",
  classified: "classified",
  classify_failed: "classify failed",
  digested: "digested",
  failed: "failed",
  raised: "error",
  registered: "registered",
  removed: "removed",
  first_seen: "first seen",
  back_online: "back online",
  went_offline: "went offline",
  created: "created",
  assigned: "assigned",
  claimed: "claimed",
  released: "re-queued",
  reopened: "reopened",
  status_changed: "status",
  run_started: "run started",
  run_finished: "run finished",
  shared_account_added: "shared account added",
  shared_account_removed: "shared account removed",
  shared_account_assigned: "shared account assigned",
  shared_account_unassigned: "shared account unassigned",
  shared_account_used: "shared account used",
};

/** The tone of an entry's action pill: good news green, trouble red, the rest quiet. */
export const actionTone = (entry: AuditEntry): Tone => {
  switch (entry.action) {
    case "failed":
    case "classify_failed":
    case "went_offline":
    case "raised":
      return "danger";
    case "classified":
      return (entry.payload as ClassifiedAuditPayload | null)?.outcome === "error"
        ? "danger"
        : "info";
    case "first_seen":
    case "back_online":
    case "registered":
    case "digested":
      return "success";
    case "released":
      return "warn";
    case "run_finished":
      return (entry.payload as { exitCode?: number } | null)?.exitCode === 0 ? "success" : "danger";
    case "removed":
    case "received":
      return "neutral";
    case "status_changed": {
      const status = (entry.payload as { status?: TicketStatus } | null)?.status;
      return status && status in STATUS ? STATUS[status].tone : "info";
    }
    default:
      return "info";
  }
};

const TONE_PILL: Readonly<Record<Tone, string>> = {
  neutral: "bg-tone-neutral-bg text-tone-neutral",
  info: "bg-tone-info-bg text-tone-info",
  progress: "bg-tone-progress-bg text-tone-progress",
  warn: "bg-tone-warn-bg text-tone-warn",
  success: "bg-tone-success-bg text-tone-success",
  danger: "bg-tone-danger-bg text-tone-danger",
};

const actionLabel = (entry: AuditEntry) => {
  if (entry.action === "status_changed") {
    const status = (entry.payload as { status?: TicketStatus } | null)?.status;
    if (status && status in STATUS) return STATUS[status].label.toLowerCase();
  }
  return ACTION_LABEL[entry.action] ?? entry.action.replaceAll("_", " ");
};

/** Worker id → the name people know it by, so rows read "verify-box", not a uuid. */
type WorkerNames = ReadonlyMap<string, string>;

const actorLabel = (e: AuditEntry, workers: WorkerNames) => {
  if (e.actorType === "coordinator") return "Coordinator";
  const id = e.actorId ?? "";
  return e.actorName ?? workers.get(id) ?? (e.actorId || e.actorType);
};

const named = (text: string, workers: WorkerNames) => {
  let out = text;
  for (const [id, name] of workers) if (out.includes(id)) out = out.replaceAll(id, name);
  return out;
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** One classifier question: every option's probability as a bar, the chosen one highlighted. */
const AnswerBars = ({
  label,
  answer,
  threshold,
}: {
  label: string;
  answer: NonNullable<ClassifiedAuditPayload["intent"]>;
  threshold?: number;
}) => {
  const options = Object.entries(answer.probabilities).sort(([, a], [, b]) => b - a);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">
          {answer.choice} at {pct(answer.confidence)}
          {threshold !== undefined && `, needs ${pct(threshold)}`}
        </span>
      </div>
      <ul className="flex flex-col gap-1" aria-label={`${label} probabilities`}>
        {options.map(([option, p]) => {
          const chosen = option === answer.choice;
          return (
            <li
              key={option}
              className="grid grid-cols-[minmax(0,9rem)_1fr_2.75rem] items-center gap-2 text-xs"
            >
              <span
                className={cn(
                  "truncate font-mono",
                  chosen ? "text-foreground" : "text-muted-foreground",
                )}
                title={option}
              >
                {option}
              </span>
              <span className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    chosen ? "bg-tone-info" : "bg-muted-foreground/40",
                  )}
                  style={{ width: `${Math.max(p * 100, 0.5)}%` }}
                />
                {threshold !== undefined && (
                  <span
                    className="absolute inset-y-0 w-px bg-foreground/50"
                    style={{ left: `${threshold * 100}%` }}
                    aria-hidden
                  />
                )}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">{pct(p)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/** Why the decision model chose what it did: each option's odds, and the model that answered. */
const Classification = ({ payload }: { payload: ClassifiedAuditPayload }) => (
  <div className="mt-1 flex flex-col gap-3 rounded-lg border px-3 py-2.5">
    {payload.intent && (
      <AnswerBars label="Intent" answer={payload.intent} threshold={payload.threshold} />
    )}
    {payload.executor && payload.intent?.choice === "new_request" && (
      <AnswerBars label="Executor" answer={payload.executor} />
    )}
    {payload.error && <p className="text-xs text-tone-danger">{payload.error}</p>}
    {payload.model && (
      <p className="text-xs text-muted-foreground">
        Model <span className="font-mono">{payload.model}</span>
      </p>
    )}
  </div>
);

interface InboundPayload {
  readonly channelType?: ChannelType;
  readonly url?: string | null;
  readonly mentionsBot?: boolean;
  readonly threadId?: string | null;
  readonly admin?: boolean;
  readonly content?: string;
}

const KindIcon = ({ entry }: { entry: AuditEntry }) => {
  const inbound = entry.kind === "inbound_event" ? (entry.payload as InboundPayload) : null;
  const channel = inbound?.channelType ? CHANNEL_META[inbound.channelType] : undefined;
  const { Icon, label } = channel ?? KIND_META[entry.kind];
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
      <Icon className="size-4" aria-label={label} role="img" />
    </span>
  );
};

const Row = ({
  entry: e,
  now,
  projects,
  workers,
}: {
  entry: AuditEntry;
  now: Date;
  projects?: ReadonlyMap<string, string>;
  workers: WorkerNames;
}) => {
  const [open, setOpen] = useState(false);
  const received = e.kind === "inbound_event" && e.action === "received";
  const inbound = e.kind === "inbound_event" ? (e.payload as InboundPayload) : null;
  const classified =
    e.kind === "inbound_event" && !received ? (e.payload as ClassifiedAuditPayload) : null;
  const time = relativeTime(e.at, now);
  return (
    <li className="flex gap-3 px-4 py-3.5 sm:px-6">
      <KindIcon entry={e} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge
            className={cn(
              "h-5 gap-1.5 border-0 px-2 text-[11px] font-medium",
              TONE_PILL[actionTone(e)],
            )}
          >
            <ToneDot tone={actionTone(e)} />
            {actionLabel(e)}
          </Badge>
          <span className="text-[13px] font-medium text-foreground">{actorLabel(e, workers)}</span>
          {inbound?.mentionsBot && <span>mentioned the bot</span>}
          {inbound?.threadId && <span>in a thread</span>}
          {inbound?.admin && <span>admin channel</span>}
          {received && e.projectId === null && !inbound?.admin && <span>unlinked channel</span>}
          {projects && e.projectId && (
            <Link
              to="/projects/$projectId"
              params={{ projectId: e.projectId }}
              className="underline-offset-2 hover:underline"
            >
              {projects.get(e.projectId) ?? e.projectId}
            </Link>
          )}
          <span className="ml-auto tabular-nums" title={new Date(e.at).toLocaleString()}>
            {inbound?.url ? (
              <a
                href={inbound.url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {time}
              </a>
            ) : (
              time
            )}
          </span>
        </div>
        <p className="text-sm break-words whitespace-pre-wrap">
          {(received && inbound ? inbound.content : named(e.summary, workers)) || (
            <span className="text-muted-foreground">{e.summary || "(no text)"}</span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {e.ticketId && e.projectId && (
            <Link
              to="/projects/$projectId/tickets/$ticketId"
              params={{ projectId: e.projectId, ticketId: e.ticketId }}
              className="underline-offset-2 hover:underline"
            >
              {(e.payload as { title?: string } | null)?.title ?? "Open ticket"}
            </Link>
          )}
          {e.workerId && e.kind !== "ticket" && (
            <span className="font-mono" title={e.workerId}>
              {workers.get(e.workerId) ?? e.workerId}
            </span>
          )}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-0.5 rounded hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Details
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        </div>
        {open && classified && <Classification payload={classified} />}
        {open && (
          <pre className="mt-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
            {JSON.stringify(
              {
                id: e.id,
                at: e.at,
                actor: { type: e.actorType, id: e.actorId, name: e.actorName },
                ...(e.ticketId && { ticketId: e.ticketId }),
                ...(e.workerId && { workerId: e.workerId }),
                payload: e.payload,
              },
              null,
              2,
            )}
          </pre>
        )}
      </div>
    </li>
  );
};

const REPORT_WINDOWS = [
  { value: "24", label: "Last 24 hours" },
  { value: "168", label: "Last 7 days" },
] as const;

/** Downloads the incident report (errors, failed tickets, outages) as a Markdown file. */
const ExportReport = ({ projectId }: { projectId: string | undefined }) => {
  const [hours, setHours] = useState<string>("24");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const report = await api.auditReport({
        hours: Number(hours),
        ...(projectId && { projectId }),
      });
      const url = URL.createObjectURL(new Blob([report.markdown], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = report.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setFailed(describeError(error as Error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      <Select
        items={REPORT_WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
        value={hours}
        onValueChange={(value) => setHours(value ?? "24")}
      >
        <SelectTrigger
          aria-label="Report window"
          className="h-[34px] min-w-36 border-border bg-card text-xs font-medium shadow-card dark:bg-card dark:hover:bg-card"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" alignItemWithTrigger={false}>
          {REPORT_WINDOWS.map((w) => (
            <SelectItem key={w.value} value={w.value} className="text-xs">
              {w.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-[34px] gap-1.5 text-xs"
        disabled={busy}
        onClick={run}
      >
        <Download className="size-3.5" /> {busy ? "Exporting…" : "Export incident report"}
      </Button>
      {failed && (
        <span role="alert" className="text-xs text-tone-danger">
          {failed}
        </span>
      )}
    </div>
  );
};

const CHIP =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const KindFilter = ({
  value,
  onChange,
}: {
  value: AuditKind | undefined;
  onChange: (kind: AuditKind | undefined) => void;
}) => {
  const chip = (kind: AuditKind | undefined, label: string) => (
    <button
      key={kind ?? "all"}
      type="button"
      aria-pressed={value === kind}
      onClick={() => onChange(kind)}
      className={cn(
        CHIP,
        value === kind && "bg-card text-foreground shadow-card ring-1 ring-border",
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Kind"
      className="flex flex-wrap gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      {chip(undefined, "All")}
      {AUDIT_KINDS.map((k) => chip(k, KIND_META[k].label))}
    </div>
  );
};

/**
 * The audit log, newest first: org-wide with a project filter (`projects` given), one
 * project's entries (`projectId`), or one Worker's (`workerId`).
 */
export const AuditFeed = ({
  projectId,
  workerId,
  projects,
}: {
  projectId?: string;
  workerId?: string;
  projects?: ReadonlyArray<Project>;
}) => {
  const [kind, setKind] = useState<AuditKind | undefined>();
  const [project, setProject] = useState("");
  const now = useNow();
  const scope = workerId ?? projectId ?? (project || undefined);
  const feed = useInfiniteQuery({
    queryKey: [
      "audit",
      workerId ? "worker" : projectId ? "project" : "org",
      scope ?? null,
      kind ?? null,
    ],
    queryFn: ({ pageParam }) => {
      const query = { ...(kind && { kind }), ...(pageParam && { before: pageParam }) };
      if (workerId) return api.workerAudit(workerId, query);
      return projectId
        ? api.projectAudit(projectId, query)
        : api.audit({ ...query, ...(scope && { projectId: scope }) });
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: SLOW_MS,
  });
  const names = projects ? new Map(projects.map((p) => [p.id, p.name])) : undefined;
  const workerList = useQuery({
    queryKey: ["workers"],
    queryFn: api.workers,
    refetchInterval: SLOW_MS,
  });
  const workers: WorkerNames = new Map(
    (workerList.data ?? []).flatMap((w) => (w.name ? [[w.id, w.name] as const] : [])),
  );
  const entries = feed.data?.pages.flatMap((p) => p.entries) ?? [];
  const exportScope = workerId ? undefined : (projectId ?? (project || undefined));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <KindFilter value={kind} onChange={setKind} />
        {!workerId && <ExportReport projectId={exportScope} />}
        {projects && (
          <Select
            items={[
              { value: null, label: "All projects" },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
            value={project || null}
            onValueChange={(id) => setProject(id ?? "")}
          >
            <SelectTrigger
              aria-label="Project"
              className="h-[34px] min-w-36 border-border bg-card text-xs font-medium shadow-card data-placeholder:text-foreground dark:bg-card dark:hover:bg-card"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              <SelectItem value={null} className="text-xs">
                All projects
              </SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {feed.isPending ? (
        <Skeleton className="h-40" />
      ) : feed.isError ? (
        <QueryError error={feed.error} />
      ) : entries.length === 0 ? (
        <Empty
          title="Nothing logged yet"
          hint={
            workerId
              ? "This Worker's registration, outages and the tickets it worked show up here."
              : projectId
                ? "Messages in this project's channels, Channel Digest runs and ticket changes show up here."
                : "Messages the Coordinator receives, Channel Digest runs, and Worker and ticket changes show up here."
          }
        />
      ) : (
        <>
          <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-card">
            {entries.map((e) => (
              <Row
                key={e.id}
                entry={e}
                now={now}
                workers={workers}
                {...(names && { projects: names })}
              />
            ))}
          </ul>
          {feed.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              disabled={feed.isFetchingNextPage}
              onClick={() => feed.fetchNextPage()}
            >
              {feed.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          )}
        </>
      )}
    </div>
  );
};

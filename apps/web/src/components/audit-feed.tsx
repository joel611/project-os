import {
  AUDIT_KINDS,
  type AuditEntry,
  type AuditKind,
  type ChannelType,
  type Project,
  type TicketStatus,
} from "@project-os/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpenText, ChevronDown, Cpu, MessageSquare, Ticket as TicketIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@/api";
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
};

const ACTION_LABEL: Readonly<Record<string, string>> = {
  received: "received",
  digested: "digested",
  failed: "failed",
  registered: "registered",
  removed: "removed",
  first_seen: "first seen",
  back_online: "back online",
  went_offline: "went offline",
  created: "created",
  assigned: "assigned",
  claimed: "claimed",
  released: "re-queued",
  status_changed: "status",
};

/** The tone of an entry's action pill: good news green, trouble red, the rest quiet. */
export const actionTone = (entry: AuditEntry): Tone => {
  switch (entry.action) {
    case "failed":
    case "went_offline":
      return "danger";
    case "first_seen":
    case "back_online":
    case "registered":
    case "digested":
      return "success";
    case "released":
      return "warn";
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
  const inbound = e.kind === "inbound_event" ? (e.payload as InboundPayload) : null;
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
          {e.kind === "inbound_event" && e.projectId === null && !inbound?.admin && (
            <span>unlinked channel</span>
          )}
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
          {(inbound ? inbound.content : named(e.summary, workers)) || (
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
 * The audit log, newest first: org-wide with a project filter (`projects` given), or one
 * project's entries (`projectId`).
 */
export const AuditFeed = ({
  projectId,
  projects,
}: {
  projectId?: string;
  projects?: ReadonlyArray<Project>;
}) => {
  const [kind, setKind] = useState<AuditKind | undefined>();
  const [project, setProject] = useState("");
  const now = useNow();
  const scope = projectId ?? (project || undefined);
  const feed = useInfiniteQuery({
    queryKey: ["audit", projectId ? "project" : "org", scope ?? null, kind ?? null],
    queryFn: ({ pageParam }) => {
      const query = { ...(kind && { kind }), ...(pageParam && { before: pageParam }) };
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <KindFilter value={kind} onChange={setKind} />
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
            projectId
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

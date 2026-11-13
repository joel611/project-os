import { isChannelDigestSource, type MemoryEntry, type Ticket } from "@project-os/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText, Settings, Star } from "lucide-react";
import { api, ApiError, type ProjectDetail } from "@/api";
import { SLOW_MS, ticketListInterval } from "@/polling";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SOURCE_META } from "@/components/source";
import { Empty, QueryError } from "@/components/states";
import { StatusBadge } from "@/components/tone";
import { relativeTime, splitTickets, workerName } from "@/model";
import { useNow } from "@/use-now";

const Header = ({ project, sources }: ProjectDetail) => (
  <header className="flex flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex max-w-3xl flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{project.name}</h1>
          {project.slug && (
            <span className="font-mono text-[13px] text-muted-foreground">{project.slug}</span>
          )}
        </div>
        {project.customInstructions && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {project.customInstructions}
          </p>
        )}
      </div>
      <Link
        to="/projects/$projectId/settings"
        params={{ projectId: project.id }}
        className={buttonVariants({ variant: "outline" })}
      >
        <Settings />
        Settings
      </Link>
    </div>
    <div className="flex flex-wrap gap-2">
      {sources.map((s) => {
        const { Icon } = SOURCE_META[s.type];
        return (
          <Badge
            key={s.id}
            variant="outline"
            className="h-7 gap-1.5 rounded-lg bg-card px-2.5 text-[13px] font-normal text-muted-foreground"
          >
            <Icon className="size-3.5" />
            {s.name}
            {s.isDefaultResponse && (
              <Star
                className="size-3 fill-tone-warn-dot text-tone-warn-dot"
                aria-label="replies here"
              />
            )}
          </Badge>
        );
      })}
    </div>
  </header>
);

const TicketRows = ({
  tickets,
  projectId,
}: {
  tickets: ReadonlyArray<Ticket>;
  projectId: string;
}) => {
  const now = useNow();
  // Registered devices are shown by name; sandbox sessions and unknown ids by id.
  const workers = useQuery({
    queryKey: ["workers"],
    queryFn: api.workers,
    refetchInterval: SLOW_MS,
  });
  const names = new Map(workers.data?.map((w) => [w.id, workerName(w)]));
  return tickets.map((t) => (
    // The title link stretches over the whole row, so the row is clickable and keyboard-reachable.
    <TableRow key={t.id} className="relative cursor-pointer focus-within:bg-muted/50">
      <TableCell className="hidden w-40 py-3.5 pl-6 sm:table-cell">
        <StatusBadge status={t.status} />
      </TableCell>
      <TableCell className="w-full max-w-0 py-3.5 pl-4 sm:pl-2">
        {/* Narrow screens drop the Status column, so the badge rides above the title. */}
        <div className="mb-1.5 sm:hidden">
          <StatusBadge status={t.status} />
        </div>
        <Link
          to="/projects/$projectId/tickets/$ticketId"
          params={{ projectId, ticketId: t.id }}
          className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
        >
          {t.title}
        </Link>
        {t.inputSummary !== t.title && (
          <div className="mt-0.5 truncate text-[13px] text-muted-foreground">{t.inputSummary}</div>
        )}
      </TableCell>
      <TableCell
        className="hidden w-40 truncate text-[13px] text-muted-foreground lg:table-cell"
        title={t.workerId ?? undefined}
      >
        {t.workerId === null
          ? t.status === "open"
            ? "queued"
            : "—"
          : (names.get(t.workerId) ?? t.workerId)}
      </TableCell>
      <TableCell className="w-20 pr-4 text-right text-[13px] sm:w-28 sm:pr-6 text-muted-foreground tabular-nums">
        {relativeTime(t.lastActivityAt, now)}
      </TableCell>
    </TableRow>
  ));
};

const GroupRow = ({ label, count }: { label: string; count: number }) => (
  <TableRow className="hover:bg-transparent">
    <TableCell
      colSpan={4}
      className="px-4 pt-5 pb-2 text-xs sm:px-6 font-medium tracking-wide text-muted-foreground"
    >
      {label} · {count}
    </TableCell>
  </TableRow>
);

const Tickets = ({ tickets, projectId }: { tickets: ReadonlyArray<Ticket>; projectId: string }) => {
  if (tickets.length === 0)
    return (
      <Empty
        title="No tickets yet"
        hint="A message in one of this project's channels becomes a ticket here."
      />
    );
  const { active, done } = splitTickets(tickets);
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card">
      <Table>
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            <TableHead className="hidden w-40 pl-6 text-xs text-muted-foreground sm:table-cell">
              Status
            </TableHead>
            <TableHead className="pl-4 text-xs text-muted-foreground sm:pl-2">Ticket</TableHead>
            <TableHead className="hidden w-40 text-xs text-muted-foreground lg:table-cell">
              Worker
            </TableHead>
            <TableHead className="w-20 pr-4 text-right sm:w-28 sm:pr-6 text-xs text-muted-foreground">
              Activity
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <GroupRow label="Active" count={active.length} />
          <TicketRows tickets={active} projectId={projectId} />
          {done.length > 0 && <GroupRow label="Done" count={done.length} />}
          <TicketRows tickets={done} projectId={projectId} />
        </TableBody>
      </Table>
    </div>
  );
};

const Memory = ({ entries }: { entries: ReadonlyArray<MemoryEntry> }) => {
  const now = useNow();
  if (entries.length === 0)
    return (
      <Empty
        title="No memory yet"
        hint="Workers write durable project knowledge here as they work tickets."
      />
    );
  return (
    <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-card">
      {entries.map((m) => (
        <li key={m.id} className="flex flex-col gap-1.5 px-4 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="size-4 text-muted-foreground" />
            <span className="font-medium">{m.title}</span>
            <Badge variant="secondary" className="font-normal">
              {m.type.replace("_", " ")}
            </Badge>
            <span className="ml-auto text-xs text-muted-foreground">
              {m.createdBy && `${m.createdBy} · `}
              {relativeTime(m.createdAt, now)}
            </span>
          </div>
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">{m.content}</p>
          {isChannelDigestSource(m.sourceMetadata) && (
            <ul className="flex flex-col gap-1 border-l-2 pl-3 text-xs text-muted-foreground">
              {m.sourceMetadata.messages.map((s) => (
                <li key={s.id}>
                  <span className="font-medium text-foreground">{s.sender}</span>
                  {" · "}
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline-offset-2 hover:underline"
                    >
                      {relativeTime(s.sentAt, now)}
                    </a>
                  ) : (
                    relativeTime(s.sentAt, now)
                  )}
                  {s.threadId && " · in a ticket thread"}
                  <span className="block whitespace-pre-wrap">“{s.quote}”</span>
                </li>
              ))}
            </ul>
          )}
          {m.ticketId && (
            <Link
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              to="/projects/$projectId/tickets/$ticketId"
              params={{ projectId: m.projectId, ticketId: m.ticketId }}
            >
              from ticket
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
};

export const ProjectView = ({ projectId }: { projectId: string }) => {
  const detail = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.project(projectId),
    refetchInterval: SLOW_MS,
  });
  const tickets = useQuery({
    queryKey: ["tickets", projectId],
    queryFn: () => api.tickets(projectId),
    refetchInterval: (query) => ticketListInterval(query.state.data),
  });
  const memory = useQuery({
    queryKey: ["memory", projectId],
    queryFn: () => api.memory(projectId),
    refetchInterval: SLOW_MS,
  });
  const count = (n: number | undefined) =>
    n === undefined ? null : <span className="text-muted-foreground tabular-nums">{n}</span>;

  if (detail.error instanceof ApiError && detail.error.status === 404)
    return <Empty title="No such project" hint="It may have been removed. Pick one on the left." />;

  return (
    <div className="flex flex-col gap-8">
      {detail.isPending ? (
        <Skeleton className="h-14 w-80" />
      ) : detail.isError ? (
        <QueryError error={detail.error} />
      ) : (
        <Header {...detail.data} />
      )}
      <Tabs defaultValue="tickets">
        <TabsList variant="line">
          <TabsTrigger value="tickets">Tickets {count(tickets.data?.length)}</TabsTrigger>
          <TabsTrigger value="memory">Memory {count(memory.data?.length)}</TabsTrigger>
        </TabsList>
        <TabsContent value="tickets" className="pt-4">
          {tickets.isPending ? (
            <Skeleton className="h-40" />
          ) : tickets.isError ? (
            <QueryError error={tickets.error} />
          ) : (
            <Tickets tickets={tickets.data} projectId={projectId} />
          )}
        </TabsContent>
        <TabsContent value="memory" className="pt-4">
          {memory.isPending ? (
            <Skeleton className="h-40" />
          ) : memory.isError ? (
            <QueryError error={memory.error} />
          ) : (
            <Memory entries={memory.data} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
};

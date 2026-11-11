import type { MemoryEntry, Ticket } from "@project-os/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText, Settings, Star } from "lucide-react";
import { api, ApiError, type ProjectDetail } from "@/api";
import { SLOW_MS, ticketListInterval } from "@/polling";
import { Badge } from "@/components/ui/badge";
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
  <header className="flex flex-col gap-2">
    <div className="flex items-baseline gap-2">
      <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
      {project.slug && <span className="text-sm text-muted-foreground">{project.slug}</span>}
      <Link
        to="/projects/$projectId/settings"
        params={{ projectId: project.id }}
        className="ml-auto inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <Settings className="size-4" />
        Settings
      </Link>
    </div>
    {project.customInstructions && (
      <p className="max-w-2xl text-sm text-muted-foreground">{project.customInstructions}</p>
    )}
    <div className="flex flex-wrap gap-1.5">
      {sources.map((s) => {
        const { Icon } = SOURCE_META[s.type];
        return (
          <Badge key={s.id} variant="outline" className="gap-1 font-normal">
            <Icon className="size-3" />
            {s.name}
            {s.isDefaultResponse && (
              <Star className="size-3 fill-amber-400 text-amber-400" aria-label="replies here" />
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
      <TableCell className="w-36">
        <StatusBadge status={t.status} />
      </TableCell>
      <TableCell className="max-w-0">
        <Link
          to="/projects/$projectId/tickets/$ticketId"
          params={{ projectId, ticketId: t.id }}
          className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
        >
          {t.title}
        </Link>
        {t.inputSummary !== t.title && (
          <div className="truncate text-xs text-muted-foreground">{t.inputSummary}</div>
        )}
      </TableCell>
      <TableCell
        className="w-40 truncate text-sm text-muted-foreground"
        title={t.workerId ?? undefined}
      >
        {t.workerId === null
          ? t.status === "open"
            ? "queued"
            : "—"
          : (names.get(t.workerId) ?? t.workerId)}
      </TableCell>
      <TableCell className="w-28 text-right text-sm text-muted-foreground tabular-nums">
        {relativeTime(t.lastActivityAt, now)}
      </TableCell>
    </TableRow>
  ));
};

const GroupRow = ({ label, count }: { label: string; count: number }) => (
  <TableRow className="hover:bg-transparent">
    <TableCell colSpan={4} className="bg-muted/40 py-1.5 text-xs font-medium text-muted-foreground">
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
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-36">Status</TableHead>
          <TableHead>Ticket</TableHead>
          <TableHead className="w-40">Worker</TableHead>
          <TableHead className="w-28 text-right">Activity</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <GroupRow label="Active" count={active.length} />
        <TicketRows tickets={active} projectId={projectId} />
        {done.length > 0 && <GroupRow label="Done" count={done.length} />}
        <TicketRows tickets={done} projectId={projectId} />
      </TableBody>
    </Table>
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
    <ul className="flex flex-col divide-y rounded-lg border">
      {entries.map((m) => (
        <li key={m.id} className="flex flex-col gap-1 p-4">
          <div className="flex items-center gap-2">
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
    <div className="flex flex-col gap-6">
      {detail.isPending ? (
        <Skeleton className="h-14 w-80" />
      ) : detail.isError ? (
        <QueryError error={detail.error} />
      ) : (
        <Header {...detail.data} />
      )}
      <Tabs defaultValue="tickets">
        <TabsList>
          <TabsTrigger value="tickets">Tickets {count(tickets.data?.length)}</TabsTrigger>
          <TabsTrigger value="memory">Memory {count(memory.data?.length)}</TabsTrigger>
        </TabsList>
        <TabsContent value="tickets" className="pt-2">
          {tickets.isPending ? (
            <Skeleton className="h-40" />
          ) : tickets.isError ? (
            <QueryError error={tickets.error} />
          ) : (
            <Tickets tickets={tickets.data} projectId={projectId} />
          )}
        </TabsContent>
        <TabsContent value="memory" className="pt-2">
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

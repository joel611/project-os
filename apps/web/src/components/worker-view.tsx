import type { Ticket } from "@project-os/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, ApiError, type WorkerView as Worker } from "@/api";
import { AuditFeed } from "@/components/audit-feed";
import { Empty, QueryError } from "@/components/states";
import { StatusBadge, ToneDot } from "@/components/tone";
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
import {
  lastSeen,
  relativeTime,
  splitTickets,
  WORKER_GROUP_LABEL,
  WORKER_TYPE_LABEL,
  workerGroup,
  workerName,
} from "@/model";
import { ticketListInterval } from "@/polling";
import { useNow } from "@/use-now";

const Header = ({ worker: w, now }: { worker: Worker; now: Date }) => (
  <header className="flex flex-col gap-2.5">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="text-[28px] leading-tight font-semibold tracking-tight break-all">
        {workerName(w)}
      </h1>
      <Badge
        variant="outline"
        className="h-6 gap-1.5 rounded-lg bg-card px-2 text-xs font-medium"
        aria-label={`Status: ${w.status}`}
      >
        <ToneDot
          tone={w.status === "online" ? "success" : "neutral"}
          pulse={w.status === "online"}
        />
        {w.status === "online" ? "Online" : "Offline"}
      </Badge>
    </div>
    <p className="text-sm text-muted-foreground">
      {WORKER_GROUP_LABEL[workerGroup(w)]} · {WORKER_TYPE_LABEL[w.workerType]} · last heartbeat{" "}
      {lastSeen(w, now)}
    </p>
  </header>
);

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-1 bg-card px-4 py-3.5 sm:px-5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="truncate text-sm font-medium">{children}</dd>
  </div>
);

const Info = ({ worker: w, now }: { worker: Worker; now: Date }) => (
  <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border shadow-card sm:grid-cols-2 lg:grid-cols-4">
    <Field label="Worker id">
      <span className="font-mono text-[13px]" title={w.id}>
        {w.id}
      </span>
    </Field>
    <Field label="Owner">
      {w.ownerId === null ? (
        <span className="text-muted-foreground">
          {workerGroup(w) === "shared" ? "Shared pool" : "None (started by the Coordinator)"}
        </span>
      ) : (
        `${w.ownerChannelType} user ${w.ownerId}`
      )}
    </Field>
    <Field label="Last heartbeat">
      <span title={new Date(w.lastSeenAt).toLocaleString()}>{lastSeen(w, now)}</span>
    </Field>
    <Field label={w.registered ? "Registered" : "Started"}>
      <span title={new Date(w.createdAt).toLocaleString()}>{relativeTime(w.createdAt, now)}</span>
    </Field>
  </dl>
);

const TicketLink = ({ ticket: t, className }: { ticket: Ticket; className?: string }) => (
  <Link
    to="/projects/$projectId/tickets/$ticketId"
    params={{ projectId: t.projectId, ticketId: t.id }}
    className={className}
  >
    {t.title}
  </Link>
);

/** What the worker is on right now: its live tickets, or a note that it is idle. */
const Current = ({ tickets, now }: { tickets: ReadonlyArray<Ticket>; now: Date }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-sm font-semibold">Current work</h2>
    {tickets.length === 0 ? (
      <p className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground sm:px-5">
        Idle. No ticket is assigned to this worker right now.
      </p>
    ) : (
      <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-card">
        {tickets.map((t) => (
          <li key={t.id} className="relative flex flex-col gap-1.5 px-4 py-3.5 sm:px-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge status={t.status} />
              <span className="ml-auto tabular-nums">
                active {relativeTime(t.lastActivityAt, now)}
              </span>
            </div>
            <TicketLink
              ticket={t}
              className="font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
            />
            {t.inputSummary !== t.title && (
              <p className="truncate text-[13px] text-muted-foreground">{t.inputSummary}</p>
            )}
          </li>
        ))}
      </ul>
    )}
  </section>
);

const Tickets = ({ tickets, now }: { tickets: ReadonlyArray<Ticket>; now: Date }) => {
  if (tickets.length === 0)
    return (
      <Empty
        title="No tickets yet"
        hint="Tickets the Coordinator assigns to this worker show up here."
      />
    );
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card">
      <Table>
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            <TableHead className="hidden w-40 pl-6 text-xs text-muted-foreground sm:table-cell">
              Status
            </TableHead>
            <TableHead className="pl-4 text-xs text-muted-foreground sm:pl-2">Ticket</TableHead>
            <TableHead className="w-20 pr-4 text-right text-xs text-muted-foreground sm:w-28 sm:pr-6">
              Activity
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tickets.map((t) => (
            <TableRow key={t.id} className="relative cursor-pointer focus-within:bg-muted/50">
              <TableCell className="hidden w-40 py-3.5 pl-6 sm:table-cell">
                <StatusBadge status={t.status} />
              </TableCell>
              <TableCell className="w-full max-w-0 py-3.5 pl-4 sm:pl-2">
                <div className="mb-1.5 sm:hidden">
                  <StatusBadge status={t.status} />
                </div>
                <TicketLink
                  ticket={t}
                  className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
                />
              </TableCell>
              <TableCell className="w-20 pr-4 text-right text-[13px] text-muted-foreground tabular-nums sm:w-28 sm:pr-6">
                {relativeTime(t.lastActivityAt, now)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

/** One worker: who and what it is, whether it is alive, what it is working on, and its log. */
export const WorkerDetailView = ({ workerId }: { workerId: string }) => {
  const now = useNow();
  const detail = useQuery({
    queryKey: ["worker", workerId],
    queryFn: () => api.worker(workerId),
    refetchInterval: (query) => ticketListInterval(query.state.data?.tickets),
  });

  if (detail.error instanceof ApiError && detail.error.status === 404)
    return (
      <Empty
        title="No such worker"
        hint="It may have been unregistered, or its sandbox session ended. Pick one on the left."
      />
    );
  if (detail.isPending)
    return (
      <div className="flex flex-col gap-8">
        <Skeleton className="h-14 w-80" />
        <Skeleton className="h-20" />
        <Skeleton className="h-40" />
      </div>
    );
  if (detail.isError) return <QueryError error={detail.error} />;

  const { worker, tickets } = detail.data;
  const { active } = splitTickets(tickets);
  const byNewest = [...tickets].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  return (
    <div className="flex flex-col gap-8">
      <Header worker={worker} now={now} />
      <Info worker={worker} now={now} />
      <Current tickets={active} now={now} />
      <Tabs defaultValue="tickets">
        <TabsList variant="line">
          <TabsTrigger value="tickets">
            Tickets <span className="text-muted-foreground tabular-nums">{tickets.length}</span>
          </TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>
        <TabsContent value="tickets" className="pt-4">
          <Tickets tickets={byNewest} now={now} />
        </TabsContent>
        <TabsContent value="audit" className="pt-4">
          <AuditFeed workerId={workerId} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

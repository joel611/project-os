import type { Ticket } from "@project-os/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "@/api";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Empty, QueryError } from "@/components/states";
import { StatusBadge } from "@/components/tone";
import { relativeTime, splitTickets } from "@/model";
import { ticketListInterval } from "@/polling";
import { useNow } from "@/use-now";
import { useViewer } from "@/viewer";

const Rows = ({
  tickets,
  projectNames,
}: {
  tickets: ReadonlyArray<Ticket>;
  projectNames: ReadonlyMap<string, string>;
}) => {
  const now = useNow();
  return tickets.map((t) => (
    // The title link stretches over the whole row, so the row is clickable and keyboard-reachable.
    <TableRow key={t.id} className="relative cursor-pointer focus-within:bg-muted/50">
      <TableCell className="hidden w-40 py-3.5 pl-6 sm:table-cell">
        <StatusBadge status={t.status} />
      </TableCell>
      <TableCell className="w-full max-w-0 py-3.5 pl-4 sm:pl-2">
        <div className="mb-1.5 sm:hidden">
          <StatusBadge status={t.status} />
        </div>
        <Link
          to="/mine/tickets/$ticketId"
          params={{ ticketId: t.id }}
          className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
        >
          {t.title}
        </Link>
        {t.inputSummary !== t.title && (
          <div className="mt-0.5 truncate text-[13px] text-muted-foreground">{t.inputSummary}</div>
        )}
      </TableCell>
      <TableCell className="hidden w-44 truncate text-[13px] text-muted-foreground lg:table-cell">
        {projectNames.get(t.projectId) ?? "—"}
      </TableCell>
      <TableCell className="w-20 pr-4 text-right text-[13px] text-muted-foreground tabular-nums sm:w-28 sm:pr-6">
        {relativeTime(t.lastActivityAt, now)}
      </TableCell>
    </TableRow>
  ));
};

const GroupRow = ({ label, count }: { label: string; count: number }) => (
  <TableRow className="hover:bg-transparent">
    <TableCell
      colSpan={4}
      className="px-4 pt-5 pb-2 text-xs font-medium tracking-wide text-muted-foreground sm:px-6"
    >
      {label} · {count}
    </TableCell>
  </TableRow>
);

const List = () => {
  const mine = useQuery({
    queryKey: ["my-tickets"],
    queryFn: api.myTickets,
    refetchInterval: (query) => ticketListInterval(query.state.data?.tickets),
  });
  if (mine.isPending) return <Skeleton className="h-40" />;
  if (mine.isError) return <QueryError error={mine.error} />;
  if (mine.data.tickets.length === 0)
    return (
      <Empty
        title="No tickets yet"
        hint="Tickets you start on Discord, or write in, show up here."
      />
    );
  const projectNames = new Map(mine.data.projects.map((p) => [p.id, p.name]));
  const { active, done } = splitTickets(mine.data.tickets);
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card">
      <Table>
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            <TableHead className="hidden w-40 pl-6 text-xs text-muted-foreground sm:table-cell">
              Status
            </TableHead>
            <TableHead className="pl-4 text-xs text-muted-foreground sm:pl-2">Ticket</TableHead>
            <TableHead className="hidden w-44 text-xs text-muted-foreground lg:table-cell">
              Project
            </TableHead>
            <TableHead className="w-20 pr-4 text-right text-xs text-muted-foreground sm:w-28 sm:pr-6">
              Activity
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <GroupRow label="Active" count={active.length} />
          <Rows tickets={active} projectNames={projectNames} />
          {done.length > 0 && <GroupRow label="Done" count={done.length} />}
          <Rows tickets={done} projectNames={projectNames} />
        </TableBody>
      </Table>
    </div>
  );
};

/** The tickets the signed-in person started or wrote in, across every project. */
export const MyTicketsView = () => {
  const viewer = useViewer();
  const person = viewer.data?.person;
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">My tickets</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {person
            ? `Everything you started or wrote in on ${person.channelType === "discord" ? "Discord" : person.channelType}, as ${person.name ?? person.id}.`
            : "Tickets you started or wrote in, across every project."}
        </p>
      </header>
      {viewer.isPending ? (
        <Skeleton className="h-40" />
      ) : viewer.isError ? (
        <QueryError error={viewer.error} />
      ) : person ? (
        <List />
      ) : (
        <Empty
          title="No Discord account linked"
          hint={
            <>
              Run <code className="text-xs">/dashboard</code> in Discord to link this Google
              account, then sign in again with Google.
            </>
          }
        />
      )}
    </div>
  );
};

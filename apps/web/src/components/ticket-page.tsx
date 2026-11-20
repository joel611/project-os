import type { Ticket } from "@project-os/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type SyntheticEvent, useState } from "react";
import { api, ApiError, describeError, type TicketDetail } from "@/api";
import { Empty, QueryError } from "@/components/states";
import { TicketFiles } from "@/components/ticket-files";
import { StatusBadge, ToneDot } from "@/components/tone";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ASSIGNABLE_STATUSES,
  assignTargets,
  EVENT,
  hasAttachments,
  newestFirst,
  relativeTime,
  STATUS,
  workerName,
} from "@/model";
import { ticketDetailInterval } from "@/polling";
import { useNow } from "@/use-now";
import { useCan } from "@/viewer";

export type TicketBack =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "mine" };

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-sm break-words">{children ?? "—"}</dd>
  </div>
);

const when = (iso: string | null, now: Date) => (iso ? relativeTime(iso, now) : null);

const Main = ({ ticket, events }: TicketDetail) => {
  const now = useNow();
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {ticket.inputSummary !== ticket.title && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Request</h2>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{ticket.inputSummary}</p>
        </section>
      )}
      {ticket.error && (
        <p className="rounded-lg bg-tone-danger-bg p-4 text-sm text-tone-danger">{ticket.error}</p>
      )}
      {ticket.result !== null && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Result</h2>
          <pre className="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
            {typeof ticket.result === "string"
              ? ticket.result
              : JSON.stringify(ticket.result, null, 2)}
          </pre>
        </section>
      )}
      {hasAttachments(events) && <TicketFiles ticketId={ticket.id} />}
      <section className="flex flex-col gap-1 rounded-xl border bg-card p-5 shadow-card sm:p-6">
        <h2 className="pb-4 text-sm font-semibold">Activity</h2>
        <ol className="relative flex flex-col gap-5 border-l pl-5">
          {newestFirst(events).map((e) => (
            <li key={e.id} className="relative flex flex-col gap-1">
              <span className="absolute top-1.5 -left-[25px] rounded-full ring-3 ring-card">
                <ToneDot tone={EVENT[e.type].tone} />
              </span>
              <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                <span className="text-[13px] font-medium text-foreground">
                  {EVENT[e.type].label}
                </span>
                <span>{e.actorId ?? e.actor}</span>
                <time
                  dateTime={e.createdAt}
                  title={new Date(e.createdAt).toLocaleString()}
                  className="ml-auto tabular-nums"
                >
                  {relativeTime(e.createdAt, now)}
                </time>
              </div>
              {e.body && (
                <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                  {e.body}
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
};

const AssignDialog = ({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) => {
  const qc = useQueryClient();
  const workers = useQuery({ queryKey: ["workers"], queryFn: api.workers });
  const targets = assignTargets(workers.data ?? [], ticket.workerId);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const assign = useMutation({
    mutationFn: (id: string) => api.assignTicket(ticket.id, id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      onClose();
    },
  });
  const verb = ticket.workerId === null ? "Assign" : "Reassign";
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (workerId) assign.mutate(workerId);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{verb} ticket</DialogTitle>
            <DialogDescription>
              The device's Watcher starts it on its next poll.
              {ticket.workerId !== null && " Its current worker can no longer update it."}
            </DialogDescription>
          </DialogHeader>
          <Select
            items={targets.map((w) => ({ value: w.id, label: `${workerName(w)} · ${w.status}` }))}
            value={workerId}
            onValueChange={setWorkerId}
          >
            <SelectTrigger aria-label="Worker" className="w-full">
              <SelectValue placeholder={workers.isPending ? "Loading workers…" : "Pick a device"} />
            </SelectTrigger>
            <SelectContent>
              {targets.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {workerName(w)} · {w.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!workers.isPending && targets.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No other registered device to hand it to.
            </p>
          )}
          {assign.error && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(assign.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!workerId || assign.isPending}>
              {assign.isPending ? `${verb}ing…` : verb}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const Details = ({ ticket }: Pick<TicketDetail, "ticket">) => {
  const now = useNow();
  const operator = useCan("ticket", "update");
  const [assigning, setAssigning] = useState(false);
  return (
    <aside className="h-fit rounded-xl border bg-card p-5 shadow-card lg:sticky lg:top-0">
      <h2 className="pb-4 text-sm font-semibold">Details</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-1">
        <Field label="Status">{STATUS[ticket.status].label}</Field>
        <Field label="Intent">{ticket.intent}</Field>
        <Field label="Worker">
          <span className="flex flex-wrap items-center gap-2">
            {ticket.workerId ?? "—"}
            {operator && ASSIGNABLE_STATUSES.includes(ticket.status) && (
              <Button size="xs" variant="outline" onClick={() => setAssigning(true)}>
                {ticket.workerId === null ? "Assign" : "Reassign"}
              </Button>
            )}
          </span>
        </Field>
        {assigning && <AssignDialog ticket={ticket} onClose={() => setAssigning(false)} />}
        <Field label="Created">{when(ticket.createdAt, now)}</Field>
        <Field label="Started">{when(ticket.startedAt, now)}</Field>
        <Field label="Last activity">{when(ticket.lastActivityAt, now)}</Field>
        <Field label="Completed">{when(ticket.completedAt, now)}</Field>
      </dl>
    </aside>
  );
};

/** One ticket on a page of its own: the story on the left, the facts in a rail on the right. */
export const TicketPage = ({ ticketId, back }: { ticketId: string; back: TicketBack }) => {
  const detail = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => api.ticket(ticketId),
    refetchInterval: (query) => ticketDetailInterval(query.state.data?.ticket),
  });
  const project = useQuery({
    queryKey: ["project", back.kind === "project" ? back.projectId : null],
    queryFn: () => api.project(back.kind === "project" ? back.projectId : ""),
    enabled: back.kind === "project",
  });
  const backLabel = back.kind === "mine" ? "My tickets" : (project.data?.project.name ?? "Project");
  const backLink = (
    <Link
      {...(back.kind === "mine"
        ? { to: "/mine" as const }
        : { to: "/projects/$projectId" as const, params: { projectId: back.projectId } })}
      className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      {backLabel}
    </Link>
  );

  if (detail.error instanceof ApiError && detail.error.status === 404)
    return (
      <div className="flex flex-col gap-8">
        {backLink}
        <Empty title="No such ticket" hint="It may have been removed." />
      </div>
    );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        {backLink}
        {detail.data ? (
          <>
            <div>
              <StatusBadge status={detail.data.ticket.status} />
            </div>
            <h1 className="max-w-3xl text-[28px] leading-tight font-semibold tracking-tight">
              {detail.data.ticket.title}
            </h1>
          </>
        ) : (
          <h1 className="sr-only">Ticket</h1>
        )}
        <p className="font-mono text-xs text-muted-foreground">{ticketId}</p>
      </header>
      {detail.isPending ? (
        <Skeleton className="h-60" />
      ) : detail.isError ? (
        <QueryError error={detail.error} />
      ) : (
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="order-2 min-w-0 lg:order-1">
            <Main {...detail.data} />
          </div>
          <div className="order-1 lg:order-2">
            <Details ticket={detail.data.ticket} />
          </div>
        </div>
      )}
    </div>
  );
};

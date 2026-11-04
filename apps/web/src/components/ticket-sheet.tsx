import { useQuery } from "@tanstack/react-query";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/states";
import { StatusBadge, ToneDot } from "@/components/tone";
import { useApi } from "@/hooks";
import { EVENT, relativeTime } from "@/model";
import type { TicketDetail } from "@/api";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-sm">{children ?? "—"}</dd>
  </div>
);

const Json = ({ value }: { value: unknown }) =>
  value === null || value === undefined ? null : (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );

const when = (iso: string | null, now: Date) => (iso ? relativeTime(iso, now) : null);

const Body = ({ ticket, events }: TicketDetail) => {
  const now = new Date();
  return (
    <div className="flex flex-col gap-5 overflow-y-auto px-4 pb-6">
      <dl className="grid grid-cols-2 gap-3">
        <Field label="Intent">{ticket.intent}</Field>
        <Field label="Worker">{ticket.workerId}</Field>
        <Field label="Created">{when(ticket.createdAt, now)}</Field>
        <Field label="Started">{when(ticket.startedAt, now)}</Field>
        <Field label="Last activity">{when(ticket.lastActivityAt, now)}</Field>
        <Field label="Completed">{when(ticket.completedAt, now)}</Field>
      </dl>
      {ticket.inputSummary !== ticket.title && (
        <p className="text-sm whitespace-pre-wrap">{ticket.inputSummary}</p>
      )}
      {ticket.error && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
          {ticket.error}
        </p>
      )}
      {ticket.result !== null && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Result</h3>
          <Json value={ticket.result} />
        </section>
      )}
      <Separator />
      <section className="flex flex-col gap-1">
        <h3 className="pb-2 text-sm font-medium">Activity</h3>
        <ol className="relative flex flex-col gap-4 border-l pl-5">
          {events.map((e) => (
            <li key={e.id} className="relative flex flex-col gap-1">
              <span className="absolute top-1.5 -left-[25px]">
                <ToneDot tone={EVENT[e.type].tone} />
              </span>
              <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{EVENT[e.type].label}</span>
                <span>{e.actorId ?? e.actor}</span>
                <span className="ml-auto tabular-nums">{relativeTime(e.createdAt, now)}</span>
              </div>
              {e.body && <p className="text-sm whitespace-pre-wrap">{e.body}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
};

export const TicketSheet = ({
  ticketId,
  onClose,
}: {
  ticketId: string | null;
  onClose: () => void;
}) => {
  const api = useApi();
  const detail = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => api.ticket(ticketId!),
    enabled: ticketId !== null,
  });

  return (
    <Sheet open={ticketId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader>
          {detail.data ? (
            <>
              <StatusBadge status={detail.data.ticket.status} />
              <SheetTitle className="text-base">{detail.data.ticket.title}</SheetTitle>
            </>
          ) : (
            <SheetTitle className="sr-only">Ticket</SheetTitle>
          )}
          <SheetDescription className="font-mono text-xs">{ticketId}</SheetDescription>
        </SheetHeader>
        {detail.isPending ? (
          <Skeleton className="mx-4 h-60" />
        ) : detail.isError ? (
          <QueryError error={detail.error} />
        ) : (
          <Body {...detail.data} />
        )}
      </SheetContent>
    </Sheet>
  );
};

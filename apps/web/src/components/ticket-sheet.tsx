import { useQuery } from "@tanstack/react-query";
import { ticketDetailInterval } from "@/polling";
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
import { TicketFiles } from "@/components/ticket-files";
import { EVENT, hasAttachments, relativeTime } from "@/model";
import { useNow } from "@/use-now";
import { api, type TicketDetail } from "@/api";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-sm">{children ?? "—"}</dd>
  </div>
);

const when = (iso: string | null, now: Date) => (iso ? relativeTime(iso, now) : null);

const Body = ({ ticket, events }: TicketDetail) => {
  const now = useNow();
  return (
    <div className="flex flex-col gap-6 overflow-y-auto px-7 pt-6 pb-8">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
        <Field label="Intent">{ticket.intent}</Field>
        <Field label="Worker">{ticket.workerId}</Field>
        <Field label="Created">{when(ticket.createdAt, now)}</Field>
        <Field label="Started">{when(ticket.startedAt, now)}</Field>
        <Field label="Last activity">{when(ticket.lastActivityAt, now)}</Field>
        <Field label="Completed">{when(ticket.completedAt, now)}</Field>
      </dl>
      {ticket.inputSummary !== ticket.title && (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{ticket.inputSummary}</p>
      )}
      {ticket.error && (
        <p className="rounded-lg bg-tone-danger-bg p-4 text-sm text-tone-danger">{ticket.error}</p>
      )}
      {ticket.result !== null && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Result</h3>
          <pre className="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
            {typeof ticket.result === "string"
              ? ticket.result
              : JSON.stringify(ticket.result, null, 2)}
          </pre>
        </section>
      )}
      {hasAttachments(events) && <TicketFiles ticketId={ticket.id} />}
      <Separator />
      <section className="flex flex-col gap-1">
        <h3 className="pb-3 text-sm font-semibold">Activity</h3>
        <ol className="relative flex flex-col gap-5 border-l pl-5">
          {events.map((e) => (
            <li key={e.id} className="relative flex flex-col gap-1">
              <span className="absolute top-1.5 -left-[25px] rounded-full ring-3 ring-popover">
                <ToneDot tone={EVENT[e.type].tone} />
              </span>
              <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                <span className="text-[13px] font-medium text-foreground">
                  {EVENT[e.type].label}
                </span>
                <span>{e.actorId ?? e.actor}</span>
                <span className="ml-auto tabular-nums">{relativeTime(e.createdAt, now)}</span>
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

export const TicketSheet = ({
  ticketId,
  onClose,
}: {
  ticketId: string | null;
  onClose: () => void;
}) => {
  const detail = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => api.ticket(ticketId!),
    enabled: ticketId !== null,
    refetchInterval: (query) => ticketDetailInterval(query.state.data?.ticket),
  });

  return (
    // No trigger opens the sheet (the URL does), so any requested change is a close.
    <Sheet open={ticketId !== null} onOpenChange={onClose}>
      <SheetContent className="w-full gap-0 shadow-float sm:inset-y-3! sm:right-3! sm:h-auto! sm:max-w-xl sm:rounded-2xl sm:border">
        <SheetHeader className="gap-3 border-b px-7 pt-7 pb-5">
          {detail.data ? (
            <>
              <StatusBadge status={detail.data.ticket.status} />
              <SheetTitle className="pr-8 text-xl leading-snug font-semibold tracking-tight">
                {detail.data.ticket.title}
              </SheetTitle>
            </>
          ) : (
            <SheetTitle className="sr-only">Ticket</SheetTitle>
          )}
          <SheetDescription className="font-mono text-xs">{ticketId}</SheetDescription>
        </SheetHeader>
        {detail.isPending ? (
          <Skeleton className="mx-7 mt-6 h-60" />
        ) : detail.isError ? (
          <QueryError error={detail.error} />
        ) : (
          <Body {...detail.data} />
        )}
      </SheetContent>
    </Sheet>
  );
};

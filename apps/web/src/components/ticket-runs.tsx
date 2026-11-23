import type { Run, RunEventType } from "@project-os/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/api";
import { QueryError } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  filterRunEvents,
  formatBytes,
  relativeTime,
  RUN_EVENT,
  RUN_STATUS,
  runDuration,
  runToJsonl,
} from "@/model";
import { LIVE_MS } from "@/polling";
import { ToneDot } from "@/components/tone";
import { useNow } from "@/use-now";

const EVENT_TEXT_TONE: Readonly<Record<string, string>> = {
  error: "text-tone-danger",
  tool_call: "text-foreground",
  message: "text-foreground",
};

const Transcript = ({ run, live }: { run: Run; live: boolean }) => {
  const transcript = useQuery({
    queryKey: ["ticket-run", run.ticketId, run.id],
    queryFn: () => api.ticketRun(run.ticketId, run.id),
    // A running session keeps adding events; a finished one is fixed.
    refetchInterval: live ? LIVE_MS : false,
  });
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<RunEventType>>(new Set(["tool_result"]));
  const events = useMemo(
    () => filterRunEvents(transcript.data?.events ?? [], { search, hidden }),
    [transcript.data, search, hidden],
  );

  if (transcript.isPending) return <Skeleton className="h-24" />;
  if (transcript.isError) return <QueryError error={transcript.error} />;
  if (run.expired) {
    return (
      <p className="text-xs text-muted-foreground">
        The transcript was deleted after the retention period. The summary above is kept.
      </p>
    );
  }

  const download = () => {
    const url = URL.createObjectURL(
      new Blob([runToJsonl(transcript.data.events)], { type: "application/x-ndjson" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `run-${run.id}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this run"
          aria-label="Search this run"
          className="h-8 w-48"
        />
        {(Object.keys(RUN_EVENT) as RunEventType[]).map((type) => {
          const off = hidden.has(type);
          return (
            <Button
              key={type}
              type="button"
              size="sm"
              variant={off ? "outline" : "secondary"}
              aria-pressed={!off}
              className="h-7 px-2 text-xs"
              onClick={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (off) next.delete(type);
                  else next.add(type);
                  return next;
                })
              }
            >
              {RUN_EVENT[type].label}
            </Button>
          );
        })}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-7 gap-1 px-2 text-xs"
          onClick={download}
        >
          <Download className="size-3.5" /> Download
        </Button>
      </div>
      {run.truncated && (
        <p className="text-xs text-tone-warn">
          The size limit for one run was reached; the end of the session is missing.
        </p>
      )}
      {events.length === 0 ? (
        <p className="text-xs text-muted-foreground">No events match.</p>
      ) : (
        <ol className="flex max-h-[32rem] flex-col gap-1.5 overflow-y-auto rounded-lg bg-muted p-3 font-mono text-xs">
          {events.map((e, i) => (
            <li key={i} className="flex min-w-0 gap-2">
              <span className="mt-1">
                <ToneDot tone={RUN_EVENT[e.type].tone} />
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-muted-foreground">
                  {RUN_EVENT[e.type].label}
                  {e.tool ? ` · ${e.tool}` : ""} ·{" "}
                  <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time>
                </span>
                <pre
                  className={cn(
                    "break-words whitespace-pre-wrap",
                    EVENT_TEXT_TONE[e.type] ?? "text-muted-foreground",
                  )}
                >
                  {e.text}
                  {e.truncated ? " …[cut]" : ""}
                </pre>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

const RunRow = ({ run, now }: { run: Run; now: Date }) => {
  const [open, setOpen] = useState(false);
  const status = RUN_STATUS[run.status];
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left"
      >
        <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
        <Badge variant="outline" className="gap-1.5">
          <ToneDot tone={status.tone} pulse={run.status === "running"} />
          {status.label}
        </Badge>
        <span className="text-sm font-medium">{run.agent}</span>
        {run.model && <span className="text-xs text-muted-foreground">{run.model}</span>}
        <span className="text-xs text-muted-foreground">on {run.workerId}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {relativeTime(run.startedAt, now)} · {runDuration(run, now)} · {run.eventCount} events
          {run.errorCount > 0 && (
            <span className="text-tone-danger"> · {run.errorCount} errors</span>
          )}
          {run.bytes > 0 && ` · ${formatBytes(run.bytes)}`}
        </span>
      </button>
      {open && <Transcript run={run} live={run.status === "running"} />}
    </li>
  );
};

/**
 * What the agent did on a ticket: one row per session, newest first, each opening into its
 * transcript (messages, tool calls, errors) with search, type filters and a JSONL download.
 * Hidden when the ticket has no recorded session.
 */
export const TicketRuns = ({ ticketId, live }: { ticketId: string; live: boolean }) => {
  const now = useNow();
  const runs = useQuery({
    queryKey: ["ticket-runs", ticketId],
    queryFn: () => api.ticketRuns(ticketId),
    refetchInterval: live ? LIVE_MS : false,
  });
  if (runs.isPending) return <Skeleton className="h-16" />;
  if (runs.isError) return <QueryError error={runs.error} />;
  if (runs.data.runs.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Runs</h2>
      <ul className="flex flex-col gap-2">
        {[...runs.data.runs].reverse().map((run) => (
          <RunRow key={run.id} run={run} now={now} />
        ))}
      </ul>
    </section>
  );
};

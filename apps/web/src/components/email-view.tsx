import type { MyEmail } from "@project-os/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, describeError } from "@/api";
import { Empty, QueryError } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/model";
import { useNow } from "@/use-now";
import { useViewer } from "@/viewer";

type Waiting = MyEmail["unassigned"][number];

const QUERY_KEY = ["my-email"];

const Row = ({ email, projects }: { email: Waiting; projects: MyEmail["projects"] }) => {
  const now = useNow();
  const qc = useQueryClient();
  const assign = useMutation({
    mutationFn: (projectId: string | null) => api.assignEmail(email.id, projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  const suggested = projects.find((p) => p.id === email.suggestedProjectId);
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:px-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate font-medium">{email.subject || "(no subject)"}</p>
          <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
            {relativeTime(email.receivedAt, now)}
          </span>
        </div>
        <p className="truncate text-[13px] text-muted-foreground">
          {email.fromName ? `${email.fromName} · ` : ""}
          {email.fromAddress}
        </p>
        {email.excerpt !== "" && (
          <p className="line-clamp-2 text-[13px] text-muted-foreground">{email.excerpt}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          items={projects.map((p) => ({ value: p.id, label: p.name }))}
          value={null}
          disabled={assign.isPending}
          onValueChange={(id) => id && assign.mutate(id)}
        >
          <SelectTrigger
            aria-label={`Assign "${email.subject}" to a project`}
            className="h-[34px] min-w-44 border-border bg-card text-xs font-medium shadow-card"
          >
            <SelectValue placeholder="Assign to project…" />
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-xs">
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {suggested && (
          <Button
            variant="outline"
            size="sm"
            disabled={assign.isPending}
            onClick={() => assign.mutate(suggested.id)}
          >
            Use {suggested.name}
            {email.confidence !== null && ` · ${Math.round(email.confidence * 100)}%`}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={assign.isPending}
          onClick={() => assign.mutate(null)}
        >
          Dismiss
        </Button>
        {assign.isError && (
          <span className="text-[13px] text-destructive">{describeError(assign.error)}</span>
        )}
      </div>
    </li>
  );
};

const ALL_MAIL = "all";

const Mailbox = () => {
  const qc = useQueryClient();
  const mail = useQuery({ queryKey: QUERY_KEY, queryFn: api.myEmail, refetchInterval: 60_000 });
  const available = mail.data?.available === true;
  const labels = useQuery({
    queryKey: ["my-email-labels"],
    queryFn: api.myEmailLabels,
    enabled: available,
    retry: false,
  });
  // What the person picked in the list, not yet saved; until then, what is saved.
  const [picked, setPicked] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: (input: { enabled: boolean; label?: string }) =>
      api.setEmailEnabled(input.enabled, input.label),
    onSuccess: (data) => {
      setPicked(null);
      qc.setQueryData(QUERY_KEY, data);
    },
  });
  if (mail.isPending) return <Skeleton className="h-40" />;
  if (mail.isError) return <QueryError error={mail.error} />;
  const { enabled, needsReconnect, unassigned, projects, lastSyncAt } = mail.data;
  if (!available) {
    return (
      <Empty
        title="Email is not turned on"
        hint="An admin turns it on with EMAIL_DIGEST, then you can let the Coordinator read your Gmail."
      />
    );
  }
  const options = [
    { value: ALL_MAIL, label: "All mail (inbox)" },
    ...(labels.data ?? []).map((l) => ({ value: l.id, label: l.name })),
  ];
  const label = picked ?? mail.data.label;
  // Switched on before labels existed: on, but nothing is read until a label is chosen.
  const needsLabel = enabled && mail.data.label === null;
  const labelName = options.find((o) => o.value === mail.data.label)?.label;
  const changed = picked !== null && picked !== mail.data.label;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-xl border bg-card px-4 py-3.5 shadow-card sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">
              {enabled && !needsLabel
                ? `Reading ${labelName ?? "your chosen label"}`
                : "Not reading your mail"}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {enabled && !needsLabel
                ? lastSyncAt
                  ? "Read-only. New mail only, from the moment you turned this on."
                  : "Waiting for the first check, within a minute."
                : "Choose what to read, then turn it on. Read-only: it never sends or changes mail."}
            </p>
          </div>
          {enabled && !needsLabel && (
            <Button
              variant="outline"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ enabled: false })}
            >
              Turn off
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={options}
            value={label}
            disabled={toggle.isPending}
            onValueChange={(value) => setPicked(value)}
          >
            <SelectTrigger
              aria-label="Gmail label to read"
              className="h-[34px] min-w-56 border-border bg-card text-xs font-medium shadow-card"
            >
              <SelectValue placeholder="Choose a label…" />
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(!enabled || needsLabel || changed) && (
            <Button
              disabled={toggle.isPending || label === null}
              onClick={() => label && toggle.mutate({ enabled: true, label })}
            >
              {enabled && !needsLabel ? "Change label" : "Turn on"}
            </Button>
          )}
          {labels.isError && (
            <span className="text-[13px] text-destructive">
              Couldn't load your Gmail labels. {describeError(labels.error)}
            </span>
          )}
        </div>
      </div>
      {toggle.isError && <QueryError error={toggle.error} />}
      {enabled && needsReconnect && (
        <p className="px-2 text-sm text-destructive">
          Your Google link can't read mail. Run <code className="text-xs">/connect google</code> in
          Discord, then turn it off and on again to check.
        </p>
      )}
      {enabled && !needsLabel && !needsReconnect && unassigned.length === 0 ? (
        <Empty
          title="Nothing waiting"
          hint="Emails the Coordinator is not sure about wait here for you to pick a project."
        />
      ) : (
        unassigned.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="px-2 text-xs font-medium tracking-wide text-muted-foreground">
              Waiting for a project · {unassigned.length}
            </h2>
            <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
              {unassigned.map((e) => (
                <Row key={e.id} email={e} projects={projects} />
              ))}
            </ul>
          </section>
        )
      )}
    </div>
  );
};

/** The signed-in person's mailbox: switch it on, and file the emails the classifier was unsure of. */
export const EmailView = () => {
  const viewer = useViewer();
  const person = viewer.data?.person;
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Email</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Your Gmail, read into Project Memory: all mail, or just one label you choose. Emails the
          Coordinator is at least 90% sure about are filed under their project; the rest wait here
          for you. Filing one by hand teaches it for next time.
        </p>
      </header>
      {viewer.isPending ? (
        <Skeleton className="h-40" />
      ) : viewer.isError ? (
        <QueryError error={viewer.error} />
      ) : person ? (
        <Mailbox />
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

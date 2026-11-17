import { detectSource, type ProjectSource, suggestAlias } from "@project-os/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Pencil, Star, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { api, ApiError, describeError, type ProjectDetail } from "@/api";
import { SLOW_MS } from "@/polling";
import { Empty, QueryError } from "@/components/states";
import { PROVIDER_META, SOURCE_META, sourceMeta } from "@/components/source";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  ALIAS_HINT,
  checkSource,
  groupSources,
  confirmPhrase,
  normalizeAlias,
  removalNote,
  sourceUrl,
  type SourceInput,
} from "@/model";

const PANEL = "rounded-xl border bg-card p-6 shadow-card md:p-7";

/** A settings group: what it is on the left, its controls on the right; stacked when narrow. */
const Section = ({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) => (
  <section className="grid gap-6 border-t pt-10 first-of-type:border-t-0 first-of-type:pt-0 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] lg:gap-12">
    <div className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{hint}</p>
    </div>
    <div className="min-w-0">{children}</div>
  </section>
);

const Problems = ({ lines }: { lines: ReadonlyArray<string> }) =>
  lines.length > 0 && (
    <ul role="alert" className="flex flex-col gap-0.5 text-sm text-destructive">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );

const INVALID_LINK =
  "Not a GitHub repo or Google Drive folder link. Try owner/repo, github.com/owner/repo or a Drive folder URL.";

const sourceProblem = (e: Error, alias: string, externalId?: string) =>
  e instanceof ApiError && e.code === "SourceAlreadyLinked"
    ? `${externalId ?? "That source"} is already linked to another project.`
    : e instanceof ApiError && e.code === "SourceAliasTaken"
      ? `Another source in this project is already called "${alias}".`
      : e instanceof ApiError && e.code === "InvalidSourceAlias"
        ? ALIAS_HINT
        : e instanceof ApiError && e.code === "InvalidSourceLink"
          ? INVALID_LINK
          : describeError(e);

const EditSource = ({
  projectId,
  source,
  sources,
  onDone,
}: {
  projectId: string;
  source: ProjectSource;
  sources: ReadonlyArray<ProjectSource>;
  onDone: () => void;
}) => {
  const qc = useQueryClient();
  const [alias, setAlias] = useState(source.alias);
  const [description, setDescription] = useState(source.description ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: { alias: string; description: string | null }) =>
      api.updateSource(projectId, source.id, patch),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      onDone();
    },
    onError: (e, patch) => setProblem(sourceProblem(e, patch.alias)),
  });

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const normalized = normalizeAlias(alias);
    if (!normalized) return setProblem(ALIAS_HINT);
    if (sources.some((s) => s.id !== source.id && s.alias === normalized))
      return setProblem(`Another source in this project is already called "${normalized}".`);
    setProblem(null);
    save.mutate({ alias: normalized, description: description.trim() || null });
  };

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col gap-2">
      <Input
        aria-label="Alias"
        value={alias}
        onChange={(e) => setAlias(e.target.value)}
        placeholder="alias, e.g. design-docs"
      />
      <Textarea
        aria-label="Description"
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What's in it and when to use it (optional)"
      />
      <Problems lines={problem ? [problem] : []} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!alias.trim() || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
};

const RemoveSource = ({
  projectId,
  source,
  onClose,
}: {
  projectId: string;
  source: ProjectSource;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const phrase = confirmPhrase(source);
  const remove = useMutation({
    mutationFn: () => api.removeSource(projectId, source.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });
  const confirmed = typed.trim() === phrase;
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (confirmed) remove.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              Remove <span className="font-mono">{source.alias}</span>?
            </DialogTitle>
            <DialogDescription>{removalNote(source)}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-remove">
              Type <span className="font-mono font-semibold">{phrase}</span> to confirm
            </Label>
            <Input
              id="confirm-remove"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            <Problems lines={remove.error ? [describeError(remove.error)] : []} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!confirmed || remove.isPending}>
              {remove.isPending ? "Removing…" : "Remove source"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const SourceRow = ({
  projectId,
  source,
  sources,
}: {
  projectId: string;
  source: ProjectSource;
  sources: ReadonlyArray<ProjectSource>;
}) => {
  const { Icon, label } = sourceMeta(source.type);
  const url = sourceUrl(source);
  const [mode, setMode] = useState<"view" | "edit" | "remove">("view");
  return (
    <li className="flex items-start gap-3 px-4 py-5 sm:gap-4 sm:px-6">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" aria-label={label} />
      </span>
      {mode === "edit" ? (
        <EditSource
          projectId={projectId}
          source={source}
          sources={sources}
          onDone={() => setMode("view")}
        />
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm font-medium">{source.alias}</div>
            <div className="mt-0.5 truncate text-[13px] text-muted-foreground">{source.name}</div>
            {source.isDefaultResponse && (
              <div className="mt-1 flex items-center gap-1 text-xs font-medium text-tone-warn sm:hidden">
                <Star className="size-3 fill-tone-warn-dot text-tone-warn-dot" />
                replies here
              </div>
            )}
            {source.description && (
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {source.description}
              </p>
            )}
          </div>
          {source.isDefaultResponse && (
            <Badge className="hidden h-6 gap-1 border-0 bg-tone-warn-bg sm:inline-flex px-2.5 font-medium text-tone-warn">
              <Star className="size-3 fill-tone-warn-dot text-tone-warn-dot" />
              replies here
            </Badge>
          )}
          <button
            type="button"
            aria-label={`Edit ${source.alias}`}
            onClick={() => setMode("edit")}
            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Pencil className="size-4" />
          </button>
          <button
            type="button"
            aria-label={`Remove ${source.alias}`}
            onClick={() => setMode("remove")}
            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${source.alias}`}
              className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="size-4" />
            </a>
          )}
        </>
      )}
      {mode === "remove" && (
        <RemoveSource projectId={projectId} source={source} onClose={() => setMode("view")} />
      )}
    </li>
  );
};

const SourceList = ({
  projectId,
  sources,
}: {
  projectId: string;
  sources: ReadonlyArray<ProjectSource>;
}) =>
  sources.length === 0 ? (
    <Empty title="No sources yet" hint="Link a repo or Drive folder above." />
  ) : (
    <div className="flex flex-col gap-6">
      {groupSources(sources).map(({ provider, sources: group }) => {
        const { Logo, label } = PROVIDER_META[provider];
        const headingId = `sources-${provider}`;
        return (
          <section key={provider} aria-labelledby={headingId} className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5 px-1">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
                <Logo className="size-4" />
              </span>
              <h3 id={headingId} className="text-sm font-semibold">
                {label}
              </h3>
              <span className="text-[13px] text-muted-foreground tabular-nums">{group.length}</span>
            </div>
            <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-card">
              {group.map((s) => (
                <SourceRow key={s.id} projectId={projectId} source={s} sources={sources} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );

const AddSource = ({
  projectId,
  sources,
}: {
  projectId: string;
  sources: ReadonlyArray<ProjectSource>;
}) => {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [alias, setAlias] = useState("");
  // Until the operator types an alias, follow the link (a repo suggests its name).
  const [aliasEdited, setAliasEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const detected = detectSource(text);
  const add = useMutation({
    mutationFn: (input: SourceInput) => api.addSource(projectId, input),
    onSuccess: () => {
      setText("");
      setAlias("");
      setAliasEdited(false);
      setDescription("");
      return qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e, input) => setProblem(sourceProblem(e, input.alias, input.externalId)),
  });

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const check = checkSource({ link: text, alias, description }, sources);
    if (check.kind === "ok") {
      setProblem(null);
      add.mutate(check.input);
      return;
    }
    setProblem(
      check.kind === "duplicate"
        ? `${check.input.externalId} is already linked to this project.`
        : check.kind === "bad_alias"
          ? alias.trim()
            ? ALIAS_HINT
            : "Give it an alias that says what it's for, e.g. design-docs."
          : check.kind === "alias_taken"
            ? `Another source in this project is already called "${check.alias}".`
            : INVALID_LINK,
    );
  };

  return (
    <form onSubmit={submit} className={`${PANEL} flex flex-col gap-4`}>
      <h3 className="text-sm font-semibold">Add source</h3>
      <Input
        aria-label="GitHub repo or Google Drive folder link"
        placeholder="Paste a GitHub repo or Google Drive folder link"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (!aliasEdited) setAlias(suggestAlias(detectSource(e.target.value)));
          setProblem(null);
        }}
      />
      {detected && !problem && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {(() => {
            const { Icon, label } = SOURCE_META[detected.type];
            return (
              <>
                <Icon className="size-4" />
                {label} · {detected.externalId}
              </>
            );
          })()}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="source-alias">Alias</Label>
        <Input
          id="source-alias"
          placeholder="What it's for, e.g. design-docs"
          value={alias}
          onChange={(e) => {
            setAlias(e.target.value);
            setAliasEdited(true);
            setProblem(null);
          }}
        />
        <p className="text-xs text-muted-foreground">
          Unique in this project. Agents and people refer to the source by it.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="source-description">
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="source-description"
          rows={2}
          placeholder="What's in it and when to use it"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <Problems lines={problem ? [problem] : []} />
      <div className="flex justify-end">
        <Button type="submit" disabled={!text.trim() || !alias.trim() || add.isPending}>
          {add.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
    </form>
  );
};

const General = ({ project }: { project: ProjectDetail["project"] }) => {
  const qc = useQueryClient();
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.customInstructions);
  const [digest, setDigest] = useState(project.channelDigest);
  const [notify, setNotify] = useState(project.channelDigestNotify);
  const save = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, {
        name: name.trim(),
        customInstructions: instructions,
        channelDigest: digest,
        channelDigestNotify: notify,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", project.id] }),
  });
  const dirty =
    name !== project.name ||
    instructions !== project.customInstructions ||
    digest !== project.channelDigest ||
    notify !== project.channelDigestNotify;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className={`${PANEL} flex flex-col gap-5`}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-name">Name</Label>
        <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-instructions">Custom instructions</Label>
        <Textarea
          id="project-instructions"
          rows={6}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">Channel digest</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={digest}
            onChange={(e) => setDigest(e.target.checked)}
          />
          <span>
            Save decisions from channel chat to memory
            <span className="block text-muted-foreground">
              Reads what people say in this project's channel and ticket threads, even without
              @mentioning the bot, and saves decisions and lasting facts once a conversation goes
              quiet. Each entry keeps the messages it came from.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={notify}
            disabled={!digest}
            onChange={(e) => setNotify(e.target.checked)}
          />
          <span className={digest ? undefined : "text-muted-foreground"}>
            Post in the channel what was saved
          </span>
        </label>
      </fieldset>
      <Problems lines={save.error ? [describeError(save.error)] : []} />
      <div className="flex justify-end">
        <Button type="submit" disabled={!dirty || !name.trim() || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
};

export const SettingsPage = ({ projectId }: { projectId: string }) => {
  const detail = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.project(projectId),
    refetchInterval: SLOW_MS,
  });
  if (detail.error instanceof ApiError && detail.error.status === 404)
    return <Empty title="No such project" hint="It may have been removed. Pick one on the left." />;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {detail.data?.project.name ?? "Project"}
        </Link>
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Project settings</h1>
      </header>
      {detail.isPending ? (
        <Skeleton className="h-40" />
      ) : detail.isError ? (
        <QueryError error={detail.error} />
      ) : (
        <>
          <Section
            title="General"
            hint="The name people see, instructions every worker gets with each ticket, and what the bot keeps from channel chat."
          >
            {/* Remount when the saved row changes so fields reset to what was saved. */}
            <General key={detail.data.project.updatedAt} project={detail.data.project} />
          </Section>
          <Section
            title={`Sources · ${detail.data.sources.length}`}
            hint="Repos and Drive folders this project reads from. Workers refer to them by alias."
          >
            <div className="flex flex-col gap-5">
              <AddSource projectId={projectId} sources={detail.data.sources} />
              <SourceList projectId={projectId} sources={detail.data.sources} />
            </div>
          </Section>
        </>
      )}
    </div>
  );
};

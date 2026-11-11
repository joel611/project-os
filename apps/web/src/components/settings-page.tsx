import type { ProjectSource } from "@project-os/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Pencil, Star } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { api, ApiError, describeError, type ProjectDetail } from "@/api";
import { SLOW_MS } from "@/polling";
import { Empty, QueryError } from "@/components/states";
import { SOURCE_META } from "@/components/source";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  ALIAS_HINT,
  checkSource,
  detectSource,
  normalizeAlias,
  sourceUrl,
  suggestAlias,
  type SourceInput,
} from "@/model";

const Problems = ({ lines }: { lines: ReadonlyArray<string> }) =>
  lines.length > 0 && (
    <ul role="alert" className="flex flex-col gap-0.5 text-sm text-destructive">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );

const sourceProblem = (e: Error, alias: string, externalId?: string) =>
  e instanceof ApiError && e.code === "SourceAlreadyLinked"
    ? `${externalId ?? "That source"} is already linked to another project.`
    : e instanceof ApiError && e.code === "SourceAliasTaken"
      ? `Another source in this project is already called "${alias}".`
      : e instanceof ApiError && e.code === "InvalidSourceAlias"
        ? ALIAS_HINT
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

const SourceRow = ({
  projectId,
  source,
  sources,
}: {
  projectId: string;
  source: ProjectSource;
  sources: ReadonlyArray<ProjectSource>;
}) => {
  const { Icon, label } = SOURCE_META[source.type];
  const url = sourceUrl(source);
  const [editing, setEditing] = useState(false);
  return (
    <li className="flex items-start gap-3 p-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={label} />
      {editing ? (
        <EditSource
          projectId={projectId}
          source={source}
          sources={sources}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm font-medium">{source.alias}</div>
            <div className="truncate text-xs text-muted-foreground">
              {label} · {source.name}
            </div>
            {source.description && (
              <p className="mt-1 text-sm text-muted-foreground">{source.description}</p>
            )}
          </div>
          {source.isDefaultResponse && (
            <Badge variant="outline" className="gap-1 font-normal">
              <Star className="size-3 fill-amber-400 text-amber-400" />
              replies here
            </Badge>
          )}
          <button
            type="button"
            aria-label={`Edit ${source.alias}`}
            onClick={() => setEditing(true)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-4" />
          </button>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${source.alias}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-4" />
            </a>
          )}
        </>
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
    <ul className="flex flex-col divide-y rounded-lg border">
      {sources.map((s) => (
        <SourceRow key={s.id} projectId={projectId} source={s} sources={sources} />
      ))}
    </ul>
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
            : "Not a GitHub repo or Google Drive folder link.",
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Add source</h2>
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
      <div>
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
  const save = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, { name: name.trim(), customInstructions: instructions }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", project.id] }),
  });
  const dirty = name !== project.name || instructions !== project.customInstructions;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="flex max-w-2xl flex-col gap-4"
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
      <Problems lines={save.error ? [describeError(save.error)] : []} />
      <div>
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
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {detail.data?.project.name ?? "Project"}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Project settings</h1>
      </header>
      {detail.isPending ? (
        <Skeleton className="h-40" />
      ) : detail.isError ? (
        <QueryError error={detail.error} />
      ) : (
        <Tabs defaultValue="sources">
          <TabsList>
            <TabsTrigger value="sources">
              Sources{" "}
              <span className="text-muted-foreground tabular-nums">
                {detail.data.sources.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="general">General</TabsTrigger>
          </TabsList>
          <TabsContent value="sources" className="flex flex-col gap-6 pt-2">
            <AddSource projectId={projectId} sources={detail.data.sources} />
            <SourceList projectId={projectId} sources={detail.data.sources} />
          </TabsContent>
          <TabsContent value="general" className="pt-2">
            {/* Remount when the saved row changes so fields reset to what was saved. */}
            <General key={detail.data.project.updatedAt} project={detail.data.project} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
};

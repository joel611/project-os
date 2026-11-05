import type { ProjectSource } from "@project-os/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Star } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { api, ApiError, describeError, type ProjectDetail } from "@/api";
import { Empty, QueryError } from "@/components/states";
import { SOURCE_META } from "@/components/source";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ADDABLE_SOURCES, checkLines, sourceUrl, type AddableSource } from "@/model";

const PLACEHOLDER: Readonly<Record<AddableSource, string>> = {
  github_repo: "https://github.com/owner/repo\nowner/another-repo",
  google_drive_folder: "https://drive.google.com/drive/folders/…",
};

const Problems = ({ lines }: { lines: ReadonlyArray<string> }) =>
  lines.length > 0 && (
    <ul role="alert" className="flex flex-col gap-0.5 text-sm text-destructive">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );

const SourceRow = ({ source }: { source: ProjectSource }) => {
  const { Icon, label } = SOURCE_META[source.type];
  const url = sourceUrl(source);
  return (
    <li className="flex items-center gap-3 p-3">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={label} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{source.name}</div>
        <div className="truncate text-xs text-muted-foreground">{label}</div>
      </div>
      {source.isDefaultResponse && (
        <Badge variant="outline" className="gap-1 font-normal">
          <Star className="size-3 fill-amber-400 text-amber-400" />
          replies here
        </Badge>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${source.name}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-4" />
        </a>
      )}
    </li>
  );
};

const SourceList = ({ sources }: { sources: ReadonlyArray<ProjectSource> }) =>
  sources.length === 0 ? (
    <Empty title="No sources yet" hint="Link a repo or Drive folder below." />
  ) : (
    <ul className="flex flex-col divide-y rounded-lg border">
      {sources.map((s) => (
        <SourceRow key={s.id} source={s} />
      ))}
    </ul>
  );

const AddSources = ({
  projectId,
  sources,
}: {
  projectId: string;
  sources: ReadonlyArray<ProjectSource>;
}) => {
  const qc = useQueryClient();
  const [type, setType] = useState<AddableSource>("github_repo");
  const [text, setText] = useState("");
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const add = useMutation({
    // Sequential so one rejected link does not hide the others' result.
    mutationFn: async (inputs: ReadonlyArray<Parameters<typeof api.addSource>[1]>) => {
      const failed: string[] = [];
      for (const input of inputs) {
        try {
          await api.addSource(projectId, input);
        } catch (e) {
          failed.push(
            e instanceof ApiError && e.code === "SourceAlreadyLinked"
              ? `${input.externalId} is already linked to another project.`
              : `${input.externalId}: ${describeError(e as Error)}`,
          );
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      setProblems((p) => [...p, ...failed]);
      return qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const checks = checkLines(type, text, sources);
    const ok = checks.flatMap((c) => (c.kind === "ok" ? [c.input] : []));
    setProblems(
      checks.flatMap((c) =>
        c.kind === "invalid"
          ? [`"${c.raw}" is not a recognizable link.`]
          : c.kind === "duplicate"
            ? [
                c.in === "project"
                  ? `${c.input.externalId} is already linked to this project.`
                  : `${c.input.externalId} appears more than once.`,
              ]
            : [],
      ),
    );
    // Keep only what still needs fixing in the box.
    setText(checks.flatMap((c) => (c.kind === "invalid" ? [c.raw] : [])).join("\n"));
    if (ok.length > 0) add.mutate(ok);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Add sources</h2>
      <div className="flex gap-2" role="radiogroup" aria-label="Source type">
        {ADDABLE_SOURCES.map((t) => {
          const { Icon, label } = SOURCE_META[t];
          return (
            <Button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              variant={type === t ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setType(t);
                setProblems([]);
              }}
            >
              <Icon className="size-4" />
              {label}
            </Button>
          );
        })}
      </div>
      <Textarea
        aria-label={`${SOURCE_META[type].label} links, one per line`}
        placeholder={PLACEHOLDER[type]}
        rows={3}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setProblems([]);
        }}
      />
      <Problems lines={problems} />
      <div>
        <Button type="submit" disabled={!text.trim() || add.isPending}>
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
            <SourceList sources={detail.data.sources} />
            <AddSources projectId={projectId} sources={detail.data.sources} />
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

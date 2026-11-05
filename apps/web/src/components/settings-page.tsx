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
import { checkSource, detectSource, sourceUrl, type SourceInput } from "@/model";

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
    <Empty title="No sources yet" hint="Link a repo or Drive folder above." />
  ) : (
    <ul className="flex flex-col divide-y rounded-lg border">
      {sources.map((s) => (
        <SourceRow key={s.id} source={s} />
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
  const [problem, setProblem] = useState<string | null>(null);
  const detected = detectSource(text);
  const add = useMutation({
    mutationFn: (input: SourceInput) => api.addSource(projectId, input),
    onSuccess: () => {
      setText("");
      return qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e, input) =>
      setProblem(
        e instanceof ApiError && e.code === "SourceAlreadyLinked"
          ? `${input.externalId} is already linked to another project.`
          : describeError(e),
      ),
  });

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const check = checkSource(text, sources);
    if (check.kind === "ok") {
      setProblem(null);
      add.mutate(check.input);
    } else {
      setProblem(
        check.kind === "duplicate"
          ? `${check.input.externalId} is already linked to this project.`
          : "Not a GitHub repo or Google Drive folder link.",
      );
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Add source</h2>
      <div className="flex gap-2">
        <Input
          aria-label="GitHub repo or Google Drive folder link"
          placeholder="Paste a GitHub repo or Google Drive folder link"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
        />
        <Button type="submit" disabled={!text.trim() || add.isPending}>
          {add.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
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
      <Problems lines={problem ? [problem] : []} />
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
            <AddSource projectId={projectId} sources={detail.data.sources} />
            <SourceList sources={detail.data.sources} />
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

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, describeError, type ProjectDetail } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ADDABLE_SOURCES, parseSource, type AddableSource } from "@/model";

const SOURCE_LABEL: Readonly<Record<AddableSource, { label: string; placeholder: string }>> = {
  github_repo: { label: "GitHub repo", placeholder: "https://github.com/owner/repo" },
  google_drive_folder: {
    label: "Google Drive folder",
    placeholder: "https://drive.google.com/drive/folders/…",
  },
};

const FormError = ({ message }: { message: string | null }) =>
  message && (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );

const Settings = ({ project }: { project: ProjectDetail["project"] }) => {
  const qc = useQueryClient();
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.customInstructions);
  const save = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, { name: name.trim(), customInstructions: instructions }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", project.id] }),
  });
  const dirty = name !== project.name || instructions !== project.customInstructions;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-4">
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
      <FormError message={save.error ? describeError(save.error) : null} />
      <div>
        <Button type="submit" disabled={!dirty || !name.trim() || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
};

const AddSource = ({ projectId }: { projectId: string }) => {
  const qc = useQueryClient();
  const [type, setType] = useState<AddableSource>("github_repo");
  const [raw, setRaw] = useState("");
  const [invalid, setInvalid] = useState(false);
  const add = useMutation({
    mutationFn: (input: NonNullable<ReturnType<typeof parseSource>>) =>
      api.addSource(projectId, input),
    onSuccess: () => {
      setRaw("");
      return qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseSource(type, raw);
    setInvalid(parsed === null);
    if (parsed) add.mutate(parsed);
  };

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-3">
      <h2 className="text-sm font-medium">Add source</h2>
      <div className="flex gap-2" role="radiogroup" aria-label="Source type">
        {ADDABLE_SOURCES.map((t) => (
          <Button
            key={t}
            type="button"
            role="radio"
            aria-checked={type === t}
            variant={type === t ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setType(t);
              setInvalid(false);
            }}
          >
            {SOURCE_LABEL[t].label}
          </Button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={`${SOURCE_LABEL[type].label} link`}
          placeholder={SOURCE_LABEL[type].placeholder}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setInvalid(false);
          }}
        />
        <Button type="submit" disabled={!raw.trim() || add.isPending}>
          {add.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
      <FormError
        message={
          invalid
            ? `Not a recognizable ${SOURCE_LABEL[type].label} link.`
            : add.error
              ? describeError(add.error)
              : null
        }
      />
    </form>
  );
};

export const ProjectSettings = ({ detail }: { detail: ProjectDetail }) => (
  <div className="flex flex-col gap-8 pt-2">
    {/* Remount on server change so the fields reset to what was saved. */}
    <Settings key={detail.project.updatedAt} project={detail.project} />
    <AddSource projectId={detail.project.id} />
  </div>
);

import type {
  Skill,
  SkillCandidate,
  SkillSetDetail,
  SkillUpdateStatus,
} from "@project-os/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { api, describeError } from "@/api";
import { Empty, QueryError } from "@/components/states";
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
import { relativeTime } from "@/model";
import { SLOW_MS } from "@/polling";
import { useNow } from "@/use-now";

const KEY = ["skill-sets"] as const;

const Problem = ({ error }: { error: Error | null }) =>
  error ? <p className="text-sm text-destructive">{describeError(error)}</p> : null;

/** Create a set, or edit its name and description. */
const SetDialog = ({ set, onClose }: { set?: SkillSetDetail["set"]; onClose: () => void }) => {
  const qc = useQueryClient();
  const [name, setName] = useState(set?.name ?? "");
  const [description, setDescription] = useState(set?.description ?? "");
  const save = useMutation({
    mutationFn: () =>
      set
        ? api.updateSkillSet(set.id, { name, description })
        : api.createSkillSet({ name, description }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (name.trim()) save.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{set ? "Edit skill set" : "New skill set"}</DialogTitle>
            <DialogDescription>
              The classifier reads the description to decide which requests get this set, so say
              what kind of work it is for.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-set-name">Name</Label>
            <Input
              id="skill-set-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="development"
              maxLength={60}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-set-description">Used for</Label>
            <Textarea
              id="skill-set-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Writing and changing code, fixing bugs, reviewing pull requests, running tests"
              rows={3}
            />
          </div>
          <Problem error={save.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {set ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Paste a repo, pick which of its skills to download into the set. */
export const AddSkillsDialog = ({ set, onClose }: { set: SkillSetDetail; onClose: () => void }) => {
  const qc = useQueryClient();
  const [source, setSource] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const browse = useMutation({
    mutationFn: () => api.browseSkills(source.trim()),
    onSuccess: () => setPicked(new Set()),
  });
  const add = useMutation({
    mutationFn: () =>
      api.addSkills(set.set.id, { source: browse.data!.source, slugs: [...picked] }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const found: ReadonlyArray<SkillCandidate> = browse.data?.skills ?? [];
  const have = new Set(set.skills.map((s) => `${s.source}/${s.slug}`));
  const allPicked = found.length > 0 && found.every((c) => picked.has(c.slug));
  const toggle = (slug: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(slug)) next.add(slug);
      return next;
    });
  const find = (e: SyntheticEvent) => {
    e.preventDefault();
    if (source.trim()) browse.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add skills to {set.set.name}</DialogTitle>
          <DialogDescription>
            Paste a skills.sh or GitHub link, or owner/repo. The skills you tick are downloaded and
            pinned to that version until you update them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={find} className="flex gap-2">
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://skills.sh/vercel-labs/skills"
            aria-label="Skills source"
            autoFocus
          />
          <Button type="submit" variant="secondary" disabled={!source.trim() || browse.isPending}>
            Find
          </Button>
        </form>
        <Problem error={browse.error} />
        {browse.data && found.length === 0 && (
          <p className="text-sm text-muted-foreground">No skills found in {browse.data.source}.</p>
        )}
        {found.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {picked.size} of {found.length} selected
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPicked(allPicked ? new Set() : new Set(found.map((c) => c.slug)))}
              >
                {allPicked ? "Deselect all" : "Select all"}
              </Button>
            </div>
            <ul className="flex flex-col divide-y rounded-lg border">
              {found.map((c) => {
                const already = have.has(`${c.source}/${c.slug}`);
                return (
                  <li key={c.path}>
                    <label className="flex cursor-pointer items-start gap-3 p-3 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={picked.has(c.slug)}
                        onChange={() => toggle(c.slug)}
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex items-center gap-2 font-medium">
                          {c.name}
                          {already && <Badge variant="secondary">In set</Badge>}
                        </span>
                        {c.description && (
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {c.description}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <Problem error={add.error} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={picked.size === 0 || add.isPending} onClick={() => add.mutate()}>
            <Download /> Download {picked.size || ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const stateBadge = (status: SkillUpdateStatus | undefined) => {
  if (!status) return null;
  if (status.state === "update_available") return <Badge>Update available</Badge>;
  if (status.state === "missing") return <Badge variant="destructive">Gone upstream</Badge>;
  return <Badge variant="secondary">Up to date</Badge>;
};

const SkillRow = ({
  skill,
  status,
  setId,
  now,
  busy,
  onUpdate,
}: {
  skill: Skill;
  status: SkillUpdateStatus | undefined;
  setId: string;
  now: Date;
  busy: boolean;
  onUpdate: (skillId: string) => void;
}) => {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeSkill(setId, skill.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{skill.name}</span>
          {stateBadge(status)}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {skill.source}/{skill.slug} · {skill.sha.slice(0, 7)} · {skill.fileCount} file
          {skill.fileCount === 1 ? "" : "s"} · downloaded {relativeTime(skill.fetchedAt, now)}
          {skill.fetchedBy ? ` by ${skill.fetchedBy}` : ""}
        </span>
        {skill.description && (
          <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</span>
        )}
      </div>
      <div className="flex gap-1.5">
        {status?.state === "update_available" && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onUpdate(skill.id)}>
            Update
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${skill.name}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
};

const SetCard = ({ detail, now }: { detail: SkillSetDetail; now: Date }) => {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<"edit" | "add" | "delete" | null>(null);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, SkillUpdateStatus>>(new Map());
  const check = useMutation({
    mutationFn: () => api.skillUpdates(detail.set.id),
    onSuccess: (report) => setStatuses(new Map(report.statuses.map((s) => [s.skillId, s]))),
  });
  const update = useMutation({
    mutationFn: (skillIds?: readonly string[]) => api.updateSkills(detail.set.id, skillIds),
    onSuccess: async () => {
      setStatuses(new Map());
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSkillSet(detail.set.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const outdated = [...statuses.values()].filter((s) => s.state === "update_available");
  return (
    <section className="flex flex-col rounded-xl border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">{detail.set.name}</h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            {detail.set.description ||
              "No description: the classifier can't tell what this is for."}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setDialog("add")}>
            <Plus /> Add skills
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={detail.skills.length === 0 || check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCw /> Check for updates
          </Button>
          {outdated.length > 0 && (
            <Button size="sm" disabled={update.isPending} onClick={() => update.mutate(undefined)}>
              Update all ({outdated.length})
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Edit"
            onClick={() => setDialog("edit")}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete skill set"
            onClick={() => setDialog("delete")}
          >
            <Trash2 />
          </Button>
        </div>
      </header>
      <div className="flex flex-col gap-2 px-4 pb-2 empty:hidden">
        <Problem error={check.error ?? update.error} />
      </div>
      {detail.skills.length === 0 ? (
        <p className="border-t px-4 py-6 text-center text-sm text-muted-foreground">
          No skills yet. A set with no skills is never offered to the classifier.
        </p>
      ) : (
        <ul className="divide-y border-t">
          {detail.skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              status={statuses.get(skill.id)}
              setId={detail.set.id}
              now={now}
              busy={update.isPending}
              onUpdate={(id) => update.mutate([id])}
            />
          ))}
        </ul>
      )}
      {dialog === "edit" && <SetDialog set={detail.set} onClose={() => setDialog(null)} />}
      {dialog === "add" && <AddSkillsDialog set={detail} onClose={() => setDialog(null)} />}
      {dialog === "delete" && (
        <Dialog open onOpenChange={(open) => !open && setDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {detail.set.name}?</DialogTitle>
              <DialogDescription>
                Its {detail.skills.length} pinned skill{detail.skills.length === 1 ? "" : "s"} are
                removed. Tickets already routed to it start with no skills.
              </DialogDescription>
            </DialogHeader>
            <Problem error={remove.error} />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
};

export const SkillsView = () => {
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const sets = useQuery({ queryKey: KEY, queryFn: api.skillSets, refetchInterval: SLOW_MS });
  const list = sets.data?.sets ?? [];
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Skill sets</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Groups of agent skills from skills.sh. When a new request fits a set, its skills are put
            on the Worker before the ticket starts. Skills are pinned to the version you downloaded
            and change only when you update them. They are written by third parties and run with the
            Worker's access, so add only ones you trust.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus /> New skill set
        </Button>
      </header>
      {sets.error ? (
        <QueryError error={sets.error} />
      ) : sets.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : list.length === 0 ? (
        <Empty
          title="No skill sets yet"
          hint='Create one, such as "development", then add skills to it from skills.sh.'
        />
      ) : (
        <div className="flex flex-col gap-4">
          {list.map((detail) => (
            <SetCard key={detail.set.id} detail={detail} now={now} />
          ))}
        </div>
      )}
      {creating && <SetDialog onClose={() => setCreating(false)} />}
    </div>
  );
};

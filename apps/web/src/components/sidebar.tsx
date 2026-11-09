import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderKanban, LogOut, Network } from "lucide-react";
import { api, type WorkerView } from "@/api";
import { authClient } from "@/auth";
import { Button } from "@/components/ui/button";
import { session } from "@/session";
import { groupWorkers, relativeTime, type WorkerGroup, workerName } from "@/model";
import { useNow } from "@/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { ToneDot } from "@/components/tone";
import { QueryError } from "@/components/states";

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h2 className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
    {children}
  </h2>
);

const Projects = () => {
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });

  if (projects.isPending) return <Skeleton className="mx-2 h-8" />;
  if (projects.isError) return <QueryError error={projects.error} />;
  if (projects.data.length === 0)
    return (
      <p className="px-2 text-sm text-muted-foreground">
        No projects yet. Create one in the Discord admin channel or run{" "}
        <code className="text-xs">bun run seed</code>.
      </p>
    );

  return (
    <nav className="flex flex-col gap-0.5">
      {projects.data.map((p) => (
        <Link
          key={p.id}
          to="/projects/$projectId"
          params={{ projectId: p.id }}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
          activeProps={{ className: "bg-muted font-medium" }}
        >
          <FolderKanban className="size-4 text-muted-foreground" />
          <span className="truncate">{p.name}</span>
        </Link>
      ))}
    </nav>
  );
};

const WORKER_GROUPS: ReadonlyArray<{ readonly group: WorkerGroup; readonly title: string }> = [
  { group: "shared", title: "Shared pool" },
  { group: "personal", title: "Personal" },
  { group: "sandbox", title: "Sandbox sessions" },
];

const WorkerRow = ({ worker: w, now }: { readonly worker: WorkerView; readonly now: Date }) => (
  <li className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm">
    <span className="pt-1.5">
      <ToneDot tone={w.status === "online" ? "success" : "neutral"} />
    </span>
    <div className="min-w-0">
      <div className="truncate font-medium" title={w.id}>
        {workerName(w)}
      </div>
      <div className="text-xs text-muted-foreground">
        {w.status === "online" ? "online" : "offline"} · seen{" "}
        {Date.parse(w.lastSeenAt) <= 0 ? "never" : relativeTime(w.lastSeenAt, now)}
        {w.currentTicketId && " · working"}
      </div>
      {w.ownerId !== null && (
        <div className="truncate text-xs text-muted-foreground">
          {w.ownerChannelType} user {w.ownerId}
        </div>
      )}
    </div>
  </li>
);

const Workers = () => {
  const workers = useQuery({ queryKey: ["workers"], queryFn: api.workers });
  const now = useNow();

  if (workers.isPending) return <Skeleton className="mx-2 h-8" />;
  if (workers.isError) return <QueryError error={workers.error} />;
  const groups = groupWorkers(workers.data);
  if (WORKER_GROUPS.every(({ group }) => groups[group].length === 0))
    return (
      <p className="px-2 text-sm text-muted-foreground">
        No workers yet. Admins add shared ones with{" "}
        <code className="text-xs">/register-worker shared:True</code>; anyone can add their own
        computer with <code className="text-xs">/register-worker</code>.
      </p>
    );

  return (
    <div className="flex flex-col gap-3">
      {WORKER_GROUPS.filter(({ group }) => groups[group].length > 0).map(({ group, title }) => (
        <div key={group}>
          <h3 className="px-2 text-xs text-muted-foreground">{title}</h3>
          <ul className="flex flex-col gap-1">
            {groups[group].map((w) => (
              <WorkerRow key={w.id} worker={w} now={now} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
};

const SignOut = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = async () => {
    const token = session.token();
    session.clear();
    queryClient.clear();
    if (token) await authClient.signOut(token);
    await navigate({ to: "/login" });
  };
  return (
    <Button variant="ghost" size="sm" className="mt-auto justify-start gap-2" onClick={signOut}>
      <LogOut />
      Sign out
    </Button>
  );
};

export const Sidebar = () => (
  <aside className="flex w-64 shrink-0 flex-col gap-6 border-r bg-muted/30 p-3">
    <Link to="/" className="px-2 pt-1 text-sm font-semibold tracking-tight">
      project-os
    </Link>
    <Link
      to="/"
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
      activeProps={{ className: "bg-muted font-medium" }}
      activeOptions={{ exact: true }}
    >
      <Network className="size-4 text-muted-foreground" />
      System map
    </Link>
    <section>
      <SectionTitle>Projects</SectionTitle>
      <Projects />
    </section>
    <section>
      <SectionTitle>Workers</SectionTitle>
      <Workers />
    </section>
    <SignOut />
  </aside>
);

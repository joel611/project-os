import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderKanban } from "lucide-react";
import { api } from "@/api";
import { relativeTime } from "@/model";
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

const Workers = () => {
  const workers = useQuery({ queryKey: ["workers"], queryFn: api.workers });
  const now = new Date();

  if (workers.isPending) return <Skeleton className="mx-2 h-8" />;
  if (workers.isError) return <QueryError error={workers.error} />;
  if (workers.data.length === 0)
    return (
      <p className="px-2 text-sm text-muted-foreground">
        No worker has checked in. Start the Watcher on the host.
      </p>
    );

  return (
    <ul className="flex flex-col gap-1">
      {workers.data.map((w) => (
        <li key={w.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm">
          <span className="pt-1.5">
            <ToneDot tone={w.status === "online" ? "success" : "neutral"} />
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium">{w.id}</div>
            <div className="text-xs text-muted-foreground">
              {w.status === "online" ? "online" : "offline"} · seen{" "}
              {relativeTime(w.lastSeenAt, now)}
              {w.currentTicketId && " · working"}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
};

export const Sidebar = () => (
  <aside className="flex w-64 shrink-0 flex-col gap-6 border-r bg-muted/30 p-3">
    <Link to="/" className="px-2 pt-1 text-sm font-semibold tracking-tight">
      project-os
    </Link>
    <section>
      <SectionTitle>Projects</SectionTitle>
      <Projects />
    </section>
    <section>
      <SectionTitle>Workers</SectionTitle>
      <Workers />
    </section>
  </aside>
);

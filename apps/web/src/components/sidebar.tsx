import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FolderKanban, LogOut, Menu, Monitor, Moon, Network, Sun } from "lucide-react";
import { api, type WorkerView } from "@/api";
import { authClient } from "@/auth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { session } from "@/session";
import { groupWorkers, relativeTime, type WorkerGroup, workerName } from "@/model";
import { SLOW_MS } from "@/polling";
import { useNow } from "@/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { ToneDot } from "@/components/tone";
import { QueryError } from "@/components/states";
import { cn } from "@/lib/utils";
import { type ThemePref, useTheme } from "@/theme";

const NAV_ITEM =
  "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground";
const NAV_ACTIVE = "bg-sidebar-accent font-medium text-foreground";

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h2 className="px-2.5 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
    {children}
  </h2>
);

const Projects = () => {
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
    refetchInterval: SLOW_MS,
  });

  if (projects.isPending) return <Skeleton className="mx-2 h-8" />;
  if (projects.isError) return <QueryError error={projects.error} />;
  if (projects.data.length === 0)
    return (
      <p className="px-2.5 text-sm text-muted-foreground">
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
          className={NAV_ITEM}
          activeProps={{ className: NAV_ACTIVE }}
        >
          <FolderKanban className="size-4 shrink-0" />
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
  <li className="flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-sm">
    <span className="pt-1.5">
      <ToneDot tone={w.status === "online" ? "success" : "neutral"} />
    </span>
    <div className="min-w-0">
      <div className="truncate text-[13px] font-medium" title={w.id}>
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
  const workers = useQuery({
    queryKey: ["workers"],
    queryFn: api.workers,
    refetchInterval: SLOW_MS,
  });
  const now = useNow();

  if (workers.isPending) return <Skeleton className="mx-2 h-8" />;
  if (workers.isError) return <QueryError error={workers.error} />;
  const groups = groupWorkers(workers.data);
  if (WORKER_GROUPS.every(({ group }) => groups[group].length === 0))
    return (
      <p className="px-2.5 text-sm text-muted-foreground">
        No workers yet. Admins add shared ones with{" "}
        <code className="text-xs">/register-worker shared:True</code>; anyone can add their own
        computer with <code className="text-xs">/register-worker</code>.
      </p>
    );

  return (
    <div className="flex flex-col gap-4">
      {WORKER_GROUPS.filter(({ group }) => groups[group].length > 0).map(({ group, title }) => (
        <div key={group}>
          <h3 className="px-2.5 pb-0.5 text-xs font-medium text-muted-foreground">{title}</h3>
          <ul className="flex flex-col gap-0.5">
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
    <Button
      variant="ghost"
      size="sm"
      className="justify-start gap-2 text-muted-foreground"
      onClick={signOut}
    >
      <LogOut />
      Sign out
    </Button>
  );
};

const THEMES: ReadonlyArray<{
  readonly pref: ThemePref;
  readonly label: string;
  readonly Icon: typeof Sun;
}> = [
  { pref: "light", label: "Light", Icon: Sun },
  { pref: "dark", label: "Dark", Icon: Moon },
  { pref: "system", label: "System", Icon: Monitor },
];

const ThemeToggle = () => {
  const [pref, choose] = useTheme();
  return (
    <div
      role="group"
      aria-label="Theme"
      className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      {THEMES.map(({ pref: p, label, Icon }) => (
        <button
          key={p}
          type="button"
          aria-pressed={pref === p}
          onClick={() => choose(p)}
          className={cn(
            "inline-flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
            pref === p && "bg-card text-foreground shadow-card ring-1 ring-border",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
};

const SidebarBody = () => (
  <>
    <Link to="/" className="flex items-center gap-2.5 px-2 py-1">
      <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
        <Network className="size-4" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight">project-os</span>
    </Link>
    <Link
      to="/"
      className={NAV_ITEM}
      activeProps={{ className: NAV_ACTIVE }}
      activeOptions={{ exact: true }}
    >
      <Network className="size-4 shrink-0" />
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
    <div className="mt-auto flex flex-col gap-2 border-t border-sidebar-border pt-4">
      <ThemeToggle />
      <SignOut />
    </div>
  </>
);

const PANEL = "flex flex-col gap-7 overflow-y-auto bg-sidebar px-4 py-5 text-sidebar-foreground";

/** The fixed sidebar on wide screens. Below `md` it gives way to {@link MobileNav}. */
export const Sidebar = () => (
  <aside className={cn(PANEL, "hidden w-66 shrink-0 border-r border-sidebar-border md:flex")}>
    <SidebarBody />
  </aside>
);

/** The top bar on narrow screens; its menu button slides the sidebar in as a drawer. */
export const MobileNav = () => {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  // Following a link inside the drawer lands on a new page, so the drawer gets out of the way.
  useEffect(() => setOpen(false), [pathname]);
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar/90 px-2 backdrop-blur md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Open navigation" />}>
          <Menu />
        </SheetTrigger>
        <SheetContent
          side="left"
          className={cn(PANEL, "w-[85vw] max-w-72 border-sidebar-border sm:max-w-72")}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarBody />
        </SheetContent>
      </Sheet>
      <Link to="/" className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
          <Network className="size-3.5" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight">project-os</span>
      </Link>
    </header>
  );
};

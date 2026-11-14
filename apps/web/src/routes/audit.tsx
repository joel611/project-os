import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { api } from "@/api";
import { AuditFeed } from "@/components/audit-feed";
import { SLOW_MS } from "@/polling";

const Audit = () => {
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
    refetchInterval: SLOW_MS,
  });
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Audit log</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Everything the Coordinator received or changed: inbound messages, Channel Digest runs,
          Workers and tickets. Admin-channel messages, unlinked channels and Workers appear only
          here; a project's Audit tab shows its own entries.
        </p>
      </header>
      <AuditFeed projects={projects.data ?? []} />
    </div>
  );
};

export const Route = createFileRoute("/audit")({ component: Audit });

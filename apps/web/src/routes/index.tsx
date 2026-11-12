import { createFileRoute } from "@tanstack/react-router";
import { SystemMap } from "@/system-map/system-map";

const Home = () => (
  <div className="flex flex-col gap-8">
    <header className="flex flex-col gap-2">
      <h1 className="text-[28px] leading-tight font-semibold tracking-tight">System map</h1>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Live view of messages moving from Discord and email through the Coordinator to Workers. Pick
        a project on the left for its tickets and memory.
      </p>
    </header>
    <SystemMap />
  </div>
);

export const Route = createFileRoute("/")({ component: Home });

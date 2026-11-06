import { createFileRoute } from "@tanstack/react-router";
import { SystemMap } from "@/system-map/system-map";

const Home = () => (
  <div className="flex flex-col gap-4">
    <header className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold tracking-tight">System map</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Live view of messages moving from Discord and email through the Coordinator to Workers. Pick
        a project on the left for its tickets and memory.
      </p>
    </header>
    <SystemMap />
  </div>
);

export const Route = createFileRoute("/")({ component: Home });

import { createFileRoute } from "@tanstack/react-router";
import { Empty } from "@/components/states";

export const Route = createFileRoute("/")({
  component: () => (
    <Empty title="Pick a project" hint="Tickets, sources, and memory show up here." />
  ),
});

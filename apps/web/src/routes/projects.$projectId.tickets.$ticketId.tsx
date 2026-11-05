import { createFileRoute } from "@tanstack/react-router";

// The parent route renders the ticket sheet; this route only gives each ticket a URL.
export const Route = createFileRoute("/projects/$projectId/tickets/$ticketId")({
  component: () => null,
});

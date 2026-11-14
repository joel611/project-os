import { createFileRoute } from "@tanstack/react-router";
import { TicketPage } from "@/components/ticket-page";

// `$projectId_` opts out of nesting under the project view so the page stands alone.
export const Route = createFileRoute("/projects/$projectId_/tickets/$ticketId")({
  component: () => {
    const { projectId, ticketId } = Route.useParams();
    return <TicketPage key={ticketId} ticketId={ticketId} back={{ kind: "project", projectId }} />;
  },
});

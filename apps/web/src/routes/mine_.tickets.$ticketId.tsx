import { createFileRoute } from "@tanstack/react-router";
import { TicketPage } from "@/components/ticket-page";

// `mine_` opts out of nesting under the ticket list so the page stands alone.
export const Route = createFileRoute("/mine_/tickets/$ticketId")({
  component: () => <TicketPage ticketId={Route.useParams().ticketId} back={{ kind: "mine" }} />,
});

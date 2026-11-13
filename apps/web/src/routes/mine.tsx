import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { MyTicketsView } from "@/components/my-tickets";
import { TicketSheet } from "@/components/ticket-sheet";

const Mine = () => {
  // Read from the child ticket route; the sheet stays mounted so it can animate closed.
  const { ticketId = null } = useParams({ strict: false });
  const navigate = useNavigate();
  return (
    <>
      <MyTicketsView />
      <TicketSheet ticketId={ticketId} onClose={() => navigate({ to: "/mine" })} />
    </>
  );
};

export const Route = createFileRoute("/mine")({ component: Mine });

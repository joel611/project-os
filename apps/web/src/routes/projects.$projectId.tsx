import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { ProjectView } from "@/components/project-view";
import { TicketSheet } from "@/components/ticket-sheet";

const Project = () => {
  const { projectId } = Route.useParams();
  // Read from the child ticket route; the sheet stays mounted so it can animate closed.
  const { ticketId = null } = useParams({ strict: false });
  const navigate = useNavigate();
  return (
    <>
      <ProjectView key={projectId} projectId={projectId} />
      <TicketSheet
        ticketId={ticketId}
        onClose={() => navigate({ to: "/projects/$projectId", params: { projectId } })}
      />
    </>
  );
};

export const Route = createFileRoute("/projects/$projectId")({ component: Project });

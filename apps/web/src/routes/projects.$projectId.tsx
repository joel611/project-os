import { createFileRoute } from "@tanstack/react-router";
import { ProjectView } from "@/components/project-view";

const Project = () => {
  const { projectId } = Route.useParams();
  return <ProjectView key={projectId} projectId={projectId} />;
};

export const Route = createFileRoute("/projects/$projectId")({ component: Project });

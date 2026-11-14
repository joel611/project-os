import { createFileRoute } from "@tanstack/react-router";
import { WorkerDetailView } from "@/components/worker-view";

const Worker = () => {
  const { workerId } = Route.useParams();
  return <WorkerDetailView key={workerId} workerId={workerId} />;
};

export const Route = createFileRoute("/workers/$workerId")({ component: Worker });

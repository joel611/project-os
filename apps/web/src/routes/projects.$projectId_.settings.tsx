import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/settings-page";

// `$projectId_` opts out of nesting under the project view so the page stands alone.
export const Route = createFileRoute("/projects/$projectId_/settings")({
  component: () => <SettingsPage projectId={Route.useParams().projectId} />,
});

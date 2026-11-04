import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Empty } from "@/components/states";
import { ProjectView } from "@/components/project-view";
import { Sidebar } from "@/components/sidebar";
import { TicketSheet } from "@/components/ticket-sheet";
import { useRoute } from "@/hooks";
import { formatRoute } from "@/model";
import "./index.css";

// Polling is enough for a single-operator POC; the Coordinator has no push channel yet.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 3_000, retry: 1 } },
});

const App = () => {
  const route = useRoute();
  const projectId = route.view === "project" ? route.projectId : null;

  return (
    <div className="flex h-svh">
      <Sidebar selectedId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto p-8">
        {projectId ? (
          <ProjectView key={projectId} projectId={projectId} />
        ) : (
          <Empty title="Pick a project" hint="Tickets, sources, and memory show up here." />
        )}
      </main>
      <TicketSheet
        ticketId={route.view === "project" ? route.ticketId : null}
        onClose={() => {
          if (projectId)
            window.location.hash = formatRoute({ view: "project", projectId, ticketId: null });
        }}
      />
    </div>
  );
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

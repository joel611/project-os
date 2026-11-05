import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { Empty } from "@/components/states";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  // Polling is enough for a single-operator POC; the Coordinator has no push channel yet.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchInterval: 3_000, retry: 1 } },
  });
  return createRouter({
    routeTree,
    defaultNotFoundComponent: () => (
      <Empty title="Page not found" hint="Pick a project on the left." />
    ),
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
};

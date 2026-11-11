import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { Empty } from "@/components/states";
import { LIVE_MS } from "./polling";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  // Polling is enough for a single-operator POC; the Coordinator has no push channel yet.
  // Queries poll at LIVE_MS unless they say otherwise, and never while the tab is hidden.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchInterval: LIVE_MS,
        refetchIntervalInBackground: false,
        // Remounts and focus within this window reuse the cache instead of refetching.
        staleTime: 5_000,
        retry: 1,
      },
    },
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

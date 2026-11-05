import { ClientOnly, createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { Sidebar } from "@/components/sidebar";
import appCss from "../index.css?url";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <html lang="en">
    <head>
      <HeadContent />
    </head>
    <body>
      {children}
      <Scripts />
    </body>
  </html>
);

const Layout = () => (
  <div className="flex h-svh">
    <Sidebar />
    <main className="min-w-0 flex-1 overflow-y-auto p-8">
      <Outlet />
    </main>
  </div>
);

// The static shell serves every URL, so the layout renders only in the browser. Prerendered, it
// would hydrate against whatever route the shell was built at.
const App = () => (
  <ClientOnly>
    <Layout />
  </ClientOnly>
);

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "project-os" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: Shell,
  component: App,
});

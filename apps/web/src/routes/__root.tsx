import {
  ClientOnly,
  createRootRoute,
  HeadContent,
  Navigate,
  Outlet,
  Scripts,
  useLocation,
} from "@tanstack/react-router";
import { MobileNav, Sidebar } from "@/components/sidebar";
import { LOGIN_PATH, session } from "@/session";
import { THEME_BOOT } from "@/theme";
import appCss from "../index.css?url";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <html lang="en" suppressHydrationWarning>
    <head>
      {/* Sets the theme class before first paint, so a dark reload never flashes light. */}
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      <HeadContent />
    </head>
    <body>
      {children}
      <Scripts />
    </body>
  </html>
);

// The login page stands alone: the sidebar's polling queries would only 401 there.
const Layout = () => {
  const { pathname } = useLocation();
  if (pathname === LOGIN_PATH) return <Outlet />;
  if (!session.token()) return <Navigate to={LOGIN_PATH} replace />;
  return (
    <div className="flex h-svh flex-col md:flex-row">
      <Sidebar />
      <MobileNav />
      <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10 lg:px-14">
        <div className="mx-auto max-w-[1120px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

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

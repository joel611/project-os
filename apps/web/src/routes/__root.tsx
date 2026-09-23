/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";

const RootComponent = () => (
  <html lang="en">
    <head>
      <HeadContent />
    </head>
    <body>
      <Outlet />
      <Scripts />
    </body>
  </html>
);

export const Route = createRootRoute({
  component: RootComponent,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "project-os" },
    ],
  }),
});

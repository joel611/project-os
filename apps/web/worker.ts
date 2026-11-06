// Dashboard Worker (deployed by alchemy.run.ts). Static assets are served by Cloudflare's
// asset layer before this runs; only `/api/*` reaches it (`runWorkerFirst`). It strips the
// prefix and forwards to the Coordinator over the COORDINATOR service binding, matching
// the Vite dev proxy in vite.config.ts.

interface Env {
  readonly COORDINATOR: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
      return new Response("Not found", { status: 404 });
    }
    url.pathname = url.pathname.slice("/api".length) || "/";
    return env.COORDINATOR.fetch(new Request(url.toString(), request));
  },
};

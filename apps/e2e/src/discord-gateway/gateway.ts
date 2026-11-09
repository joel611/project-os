import { DurableObject } from "cloudflare:workers";
import gateway from "../../../discord-gateway/src/main.cloudflare.ts";

// Bundled and run in workerd by discord-gateway.test.ts. The default export is the real gateway
// Worker. Only the container is faked: this Durable Object stands where `DiscordGateway` would,
// answers like the reply endpoint, and records what reached it.

export default gateway;

interface Seen {
  readonly path: string;
  readonly body: unknown;
}

export class TestGateway extends DurableObject {
  readonly #seen: Seen[] = [];
  #started = 0;

  async ensureStarted(): Promise<void> {
    this.#started += 1;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/_log") return Response.json({ seen: this.#seen, started: this.#started });
    const body: { content?: string; name?: string } = await request.json();
    this.#seen.push({ path, body });
    if (body.content === "fail" || body.name === "fail") {
      return Response.json({ error: "discord post failed" }, { status: 502 });
    }
    if (path === "/channels") return Response.json({ channelId: "c-new", name: body.name });
    return Response.json({ ok: true });
  }
}

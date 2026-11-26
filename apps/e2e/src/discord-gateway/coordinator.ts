import { ChannelGateway } from "@project-os/core";
import { CloudflareLive, discordGatewayRoute } from "@project-os/infra-cloudflare";
import { Effect, ManagedRuntime } from "effect";

// Bundled and run in workerd by discord-gateway.test.ts. It is the Coordinator's side of the
// seam: the real CloudflareLive and the gateway route main.cloudflare.ts uses, with replies
// leaving through the DISCORD_GATEWAY service binding. Not the whole assembly.

interface Env {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly DISCORD_GATEWAY: Fetcher;
}

type Op =
  | { readonly op: "reply"; readonly content: string }
  | { readonly op: "createChannel"; readonly name: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const input: Op = await request.json();
    const runtime = ManagedRuntime.make(
      CloudflareLive({
        db: env.DB,
        kv: env.KV,
        ...discordGatewayRoute("http://discord-gateway", env.DISCORD_GATEWAY),
      }),
    );
    const result = await runtime.runPromise(
      ChannelGateway.use((g) =>
        input.op === "reply"
          ? g
              .send({
                channelType: "discord",
                channelId: "c1",
                threadId: "t1",
                content: input.content,
              })
              .pipe(Effect.map(() => ({ ok: true as const })))
          : g
              .createChannel({ channelType: "discord", name: input.name })
              .pipe(Effect.map((created) => ({ ok: true as const, created }))),
      ).pipe(
        Effect.catch((e: { message: string }) =>
          Effect.succeed({ ok: false as const, message: e.message }),
        ),
      ),
    );
    return Response.json(result);
  },
};

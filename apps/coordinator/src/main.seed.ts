import { env } from "@project-os/config";
import { DEFAULT_ORG, ensureOrg, LocalLive } from "@project-os/infra-local";
import { Effect, ManagedRuntime } from "effect";
import { seedDefaults } from "./admin/seed.ts";

// `bun run seed`: default org + a project + its Discord channel as the default response.
// Safe to re-run. Set SEED_DISCORD_CHANNEL_ID (and optionally SEED_PROJECT_NAME).
const dbPath = process.env.DATABASE_PATH ?? env("DB_PATH", "./project-os.sqlite");
const orgId = ensureOrg(dbPath, DEFAULT_ORG);

const runtime = ManagedRuntime.make(LocalLive({ dbPath, adapterUrls: {} }));
try {
  const { project, source, created } = await runtime.runPromise(
    seedDefaults({
      orgId,
      projectName: env("SEED_PROJECT_NAME", "Demo Project"),
      discordChannelId: env("SEED_DISCORD_CHANNEL_ID"),
    }).pipe(Effect.orDie),
  );
  console.log(
    `org ${orgId}; project "${project.name}" ${project.id} (${created.project ? "created" : "exists"}); ` +
      `source discord ${source.externalId} (${created.source ? "created" : "exists"}, default response)`,
  );
} finally {
  await runtime.dispose();
}

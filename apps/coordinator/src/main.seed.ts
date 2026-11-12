import { env } from "@project-os/config";
import { dataPath } from "@project-os/config/data";
import { DEFAULT_ORG, ensureOrg, LocalLive } from "@project-os/infra-local";
import { Effect, ManagedRuntime } from "effect";
import { seedDefaults } from "./admin/seed.ts";
import { seedQaData } from "./admin/seed-qa.ts";

const dbPath = dataPath("project-os.sqlite", process.env.DATABASE_PATH ?? process.env.DB_PATH);
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
  const qa = await runtime.runPromise(seedQaData(project.id).pipe(Effect.orDie));
  console.log(`qa data: +${qa.tickets} tickets, +${qa.memory} memory entries`);
} finally {
  await runtime.dispose();
}

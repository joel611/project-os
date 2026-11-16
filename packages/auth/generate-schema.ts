/**
 * `bun run auth:generate`: regenerate `@project-os/db-sqlite`'s Better Auth tables with the CLI.
 * Run `bun run db:generate` in db-sqlite afterwards for the migration.
 *
 * The CLI also emits `relations(...)` helpers (Drizzle v0 API), which `drizzle-orm` 1.0 no
 * longer exports and the adapter doesn't need, so they are cut from the output.
 */
import { $ } from "bun";

const output = new URL("../db-sqlite/src/schema/auth.ts", import.meta.url).pathname;

await $`bunx auth generate --config auth.config.ts --output ${output} --yes`.cwd(
  new URL(".", import.meta.url).pathname,
);

const generated = await Bun.file(output).text();
const cut = generated.search(/^export const \w+Relations = relations\(/m);
const tables = (cut === -1 ? generated : generated.slice(0, cut))
  .replace(/import \{ relations, sql \}/, "import { sql }")
  .trimEnd();
await Bun.write(output, `${tables}\n`);
await $`bunx vp fmt ${output}`.quiet().nothrow();

// Publish step for the Release workflow (`bun run release`).
//
// `changeset publish` shells out to `npm publish`, which ships `workspace:*`
// ranges verbatim. `bun publish` rewrites them to real versions, so we publish
// each public workspace package with bun, then let Changesets create the tags.
import { $, Glob } from "bun";

type Manifest = { name: string; version: string; private?: boolean };

const root = (await Bun.file("package.json").json()) as { workspaces: string[] };
const dirs: string[] = [];
for (const pattern of root.workspaces) {
  for await (const path of new Glob(`${pattern}/package.json`).scan(".")) {
    dirs.push(path.slice(0, -"/package.json".length));
  }
}

for (const dir of dirs.sort()) {
  const pkg = (await Bun.file(`${dir}/package.json`).json()) as Manifest;
  if (pkg.private) continue;
  const spec = `${pkg.name}@${pkg.version}`;
  const published = await $`npm view ${spec} version`.quiet().nothrow();
  if (published.exitCode === 0 && published.stdout.toString().trim() === pkg.version) {
    console.log(`skip ${spec} (already on npm)`);
    continue;
  }
  console.log(`publish ${spec}`);
  await $`bun publish --access public`.cwd(dir);
}

await $`bunx changeset tag`;

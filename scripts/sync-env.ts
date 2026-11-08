// Re-lays .env to follow .env.example (`bun run env:sync`), keeping your values.
//
// Layout, comments and defaults come from .env.example. For each key the example lists
// (active `KEY=` or commented `# KEY=`), an active line in .env wins and is copied verbatim.
// Keys only .env has go in a trailing section. The old file is saved as .env.bak.
//
//   bun run env:sync            rewrite .env
//   bun run env:sync -- --check exit 1 if .env would change (no write)
//   bun run env:sync -- [--example <path>] [--env <path>]
import { existsSync } from "node:fs";

const KEY = /^(?:#\s*)?([A-Z][A-Z0-9_]*)=/;
const ACTIVE = /^([A-Z][A-Z0-9_]*)=/;
const EXTRAS_HEADER = "# Not in .env.example (kept from your previous .env)";

export function syncEnv(example: string, current: string): string {
  const values = new Map<string, string>();
  for (const line of current.split("\n")) {
    const key = ACTIVE.exec(line)?.[1];
    if (key) values.set(key, line);
  }

  const used = new Set<string>();
  const out = example
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const key = KEY.exec(line)?.[1];
      if (!key) return line;
      used.add(key);
      return values.get(key) ?? line;
    });

  const extras = [...values].filter(([key]) => !used.has(key)).map(([, line]) => line);
  if (extras.length > 0) out.push("", EXTRAS_HEADER, ...extras);
  return `${out.join("\n")}\n`;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const examplePath = flag("--example") ?? ".env.example";
  const envPath = flag("--env") ?? ".env";
  const check = process.argv.includes("--check");

  const example = await Bun.file(examplePath).text();
  const hasEnv = existsSync(envPath);
  const current = hasEnv ? await Bun.file(envPath).text() : "";
  const next = syncEnv(example, current);

  if (next === current) {
    console.log(`${envPath} already follows ${examplePath}`);
  } else if (check) {
    console.error(`${envPath} is out of sync with ${examplePath}; run \`bun run env:sync\``);
    process.exit(1);
  } else {
    if (hasEnv) await Bun.write(`${envPath}.bak`, current);
    await Bun.write(envPath, next);
    console.log(`${envPath} synced to ${examplePath}${hasEnv ? ` (backup: ${envPath}.bak)` : ""}`);
  }
}

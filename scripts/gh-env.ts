// Uploads the non-empty keys of an env file (default .env.cf) to a GitHub Environment
// (`bun run env:gh`). Flags take `--name value` or `--name=value`.
//
// Secret-looking keys become environment secrets, everything else an environment variable,
// matching what .github/workflows/deploy.yml reads from `secrets.*` and `vars.*`. Empty and
// commented-out keys are skipped. Values go to `gh` on stdin, never on the command line.
//
//   bun run env:gh -- --env prod            upload to the `prod` environment
//   bun run env:gh -- --env uat --dry-run   print what would be set (names only)
//   bun run env:gh -- --env uat --file .env.cf.uat   upload any env file instead of .env.cf
//   bun run env:gh -- --env uat [--file <path>] [--repo owner/name]
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export const ENVIRONMENTS = ["uat", "prod"] as const;

/** Keys that must be secrets: credentials alchemy.run.ts binds as `secret_text`, and tokens. */
const SECRET_KEYS = new Set([
  "CLOUDFLARE_API_TOKEN",
  "COORDINATOR_SERVICE_TOKEN",
  "BETTER_AUTH_SECRET",
  "DISCORD_BOT_TOKEN",
  "OPENROUTER_API_KEY",
  "SKILLS_GITHUB_TOKEN",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "CLICKUP_CLIENT_SECRET",
  "DAYTONA_API_KEY",
  "BOAT_API_KEY",
  "CLOUDFLARE_SANDBOX_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
]);

/** GitHub reserves the `GITHUB_` prefix for secret and variable names. */
export const ghName = (key: string) =>
  key.startsWith("GITHUB_") ? `GH_${key.slice("GITHUB_".length)}` : key;

export type Entry = { key: string; name: string; kind: "secret" | "variable"; value: string };

/** The non-empty KEY=value pairs of an env file, classified as secret or variable. */
export function entriesOf(text: string): Entry[] {
  return Object.entries(parseEnv(text))
    .filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1] !== "")
    .map(([key, value]) => ({
      key,
      name: ghName(key),
      kind: SECRET_KEYS.has(key) ? ("secret" as const) : ("variable" as const),
      value,
    }));
}

/** The value of `--name value` or `--name=value`; undefined when absent, exits when valueless. */
function flag(name: string): string | undefined {
  const args = process.argv;
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  const value = args[i]!.includes("=") ? args[i]!.slice(name.length + 1) : args[i + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}

async function gh(args: string[], stdin?: string): Promise<void> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${err.trim()}`);
}

async function main() {
  const env = flag("--env");
  if (!ENVIRONMENTS.includes(env as (typeof ENVIRONMENTS)[number])) {
    console.error(`--env must be one of: ${ENVIRONMENTS.join(", ")}`);
    process.exit(2);
  }
  const file = flag("--file") ?? ".env.cf";
  if (!existsSync(file)) {
    console.error(`${file} not found`);
    process.exit(2);
  }
  const repoArgs = flag("--repo") ? ["-R", flag("--repo")!] : [];
  const dryRun = process.argv.includes("--dry-run");
  const entries = entriesOf(readFileSync(file, "utf8"));

  if (!dryRun) {
    // Idempotent: creates the environment if it is missing.
    const repo = flag("--repo") ?? "{owner}/{repo}";
    await gh(["api", "-X", "PUT", `repos/${repo}/environments/${env}`, "--silent"]);
  }
  for (const { key, name, kind, value } of entries) {
    const rename = name === key ? "" : ` (as ${name})`;
    console.log(`${dryRun ? "would set" : "set"} ${kind} ${key}${rename} -> ${env}`);
    if (dryRun) continue;
    await gh([kind, "set", name, "--env", env as string, ...repoArgs], value);
  }
  console.log(`${entries.length} entries${dryRun ? " (dry run, nothing uploaded)" : " uploaded"}`);
}

if (import.meta.main) await main();

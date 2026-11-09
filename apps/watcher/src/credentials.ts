import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AgentName, isAgentName } from "./agents.ts";

/** What `project-os-watcher register` saves: this computer's identity as a personal worker. */
export interface WatcherCredentials {
  /** Coordinator base URL (MCP is at `<server>/mcp`). */
  readonly server: string;
  readonly workerId: string;
  readonly name: string;
  /** Bearer secret for `/mcp`. Only this file holds it. */
  readonly secret: string;
  /** Agent CLI chosen at `register --agent`; `WATCHER_AGENT` overrides it. */
  readonly agent?: AgentName;
  /** Model chosen at `register --model`; unset uses the agent's own default. */
  readonly model?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** `$PROJECT_OS_WATCHER_HOME`, else `$XDG_CONFIG_HOME/project-os`, else `~/.config/project-os`. */
export const configDir = (env: Env = process.env): string =>
  env.PROJECT_OS_WATCHER_HOME ??
  join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "project-os");

export const credentialsPath = (env: Env = process.env): string =>
  join(configDir(env), "watcher.json");

/** Writes `contents` readable by this user only (it holds a secret). */
export const writePrivate = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
};

export const saveCredentials = (path: string, credentials: WatcherCredentials): void =>
  writePrivate(path, `${JSON.stringify(credentials, null, 2)}\n`);

export const loadCredentials = (path: string): WatcherCredentials | undefined => {
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WatcherCredentials>;
  if (!raw.server || !raw.workerId || !raw.secret) {
    throw new Error(`${path} is incomplete; run \`project-os-watcher register\` again`);
  }
  if (raw.agent !== undefined && !isAgentName(raw.agent)) {
    throw new Error(
      `${path} names an unknown agent "${raw.agent}"; run \`project-os-watcher register\` again`,
    );
  }
  return {
    server: raw.server,
    workerId: raw.workerId,
    name: raw.name ?? raw.workerId,
    secret: raw.secret,
    ...(raw.agent && { agent: raw.agent }),
    ...(raw.model && { model: raw.model }),
  };
};

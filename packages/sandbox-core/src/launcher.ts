import { SANDBOX_PROVIDER_OF } from "@project-os/contracts";
import { workerSessionStart } from "@project-os/system-prompts";
import {
  DEFAULT_SANDBOX_SESSION_SECONDS,
  LaunchFailed,
  type SandboxPoolEntry,
  type WorkerLauncher,
} from "@project-os/core";
import { Effect } from "effect";

/**
 * The provider seam: runs one shell command to completion in a throwaway sandbox, then always
 * deletes it. Daytona, Cloudflare Sandbox and (later) boat.dev each implement this.
 */
export interface SandboxRunner {
  readonly run: (input: {
    readonly env: Readonly<Record<string, string>>;
    readonly command: string;
    readonly timeoutSeconds: number;
  }) => Promise<{ readonly exitCode: number; readonly output: string }>;
}

/** One provider in the pool: what it runs as, how to start it, and how many at once. */
export interface SandboxProvider extends SandboxPoolEntry {
  readonly runner: SandboxRunner;
}

export interface SandboxLauncherConfig {
  /** The pool, in the order the Coordinator should try it. */
  readonly providers: ReadonlyArray<SandboxProvider>;
  /** Coordinator MCP URL as the sandbox sees it (public; never the host's localhost). */
  readonly mcpUrl: string;
  readonly openrouterApiKey: string;
  /**
   * The Coordinator's credential proxy (`/egress`) as the sandbox sees it. Set: the session
   * reaches GitHub, Google and ClickUp through it and never holds the person's token.
   */
  readonly egressUrl?: string;
  /** Pi model pattern, e.g. `openrouter/anthropic/claude-sonnet-4.5`. */
  readonly model: string;
  readonly timeoutSeconds?: number;
  readonly log: (message: string) => void;
}

/** Name of the Coordinator in Pi's `mcp.json`; its tools are `mcp__project-os__*`. */
export const MCP_SERVER_NAME = "project-os";

export const DEFAULT_TIMEOUT_SECONDS = DEFAULT_SANDBOX_SESSION_SECONDS;

export const piMcpJson = (mcpUrl: string, mcpToken: string): string =>
  JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        url: mcpUrl,
        headers: { Authorization: `Bearer ${mcpToken}` },
        // `direct` declares the tools to the model; the default would hide them behind codemode.
        exposure: "direct",
      },
    },
  });

// Values arrive as env vars so no ticket-derived text is ever interpolated into the shell line.
const PI_SETUP = [
  "set -e",
  "npm install -g @earendil-works/pi-coding-agent",
  "mkdir -p ~/.pi/agent",
  'printf "%s" "$PROJECT_OS_MCP_JSON" > ~/.pi/agent/mcp.json',
];
const PI_RUN = 'pi --print --model "$PROJECT_OS_MODEL" "$PROJECT_OS_PROMPT"';

// git over HTTPS to github.com goes through the credential proxy, which signs it as the person.
const EGRESS_GIT_SETUP = [
  "if command -v git >/dev/null; then " +
    'git config --global url."$PROJECT_OS_EGRESS_URL/github-git/".insteadOf "https://github.com/" && ' +
    'git config --global http."$PROJECT_OS_EGRESS_URL/".extraHeader "Authorization: Bearer $PROJECT_OS_EGRESS_TOKEN"; ' +
    "fi",
];

// The ticket's skill set, installed where Pi looks for skills before it starts. It is best
// effort: a Coordinator without skills, or one that can't be reached, must not stop the ticket.
// The script uses only Node (already there for npm) and refuses names that climb out of the folder.
const SKILLS_INSTALL_JS = [
  'const fs=require("fs"),path=require("path");',
  'const root=path.join(process.env.HOME,".pi","agent","skills");',
  'fetch(process.env.PROJECT_OS_SKILLS_URL,{headers:{authorization:"Bearer "+process.env.PROJECT_OS_SKILLS_TOKEN}})',
  ".then(r=>{if(!r.ok)throw new Error(String(r.status));return r.json()})",
  ".then(b=>{let n=0;for(const s of b.skills||[]){",
  "if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s.slug))continue;",
  "const dir=path.join(root,s.slug);",
  "for(const f of s.files){const t=path.resolve(dir,f.path);",
  "if(!t.startsWith(dir+path.sep))continue;",
  "fs.mkdirSync(path.dirname(t),{recursive:true});fs.writeFileSync(t,f.contents)}n++}",
  'console.log("skills: installed "+n)})',
  '.catch(e=>{console.error("skills: not installed ("+e.message+")")})',
].join("");
const SKILLS_SETUP = [`node -e '${SKILLS_INSTALL_JS}' || true`];

export const SESSION_COMMAND = [...PI_SETUP, ...SKILLS_SETUP, PI_RUN].join(" && ");

/** The same session, with git pointed at the credential proxy first. */
export const PROXIED_SESSION_COMMAND = [
  ...PI_SETUP,
  ...SKILLS_SETUP,
  ...EGRESS_GIT_SETUP,
  PI_RUN,
].join(" && ");

export const sessionEnv = (
  config: Pick<SandboxLauncherConfig, "mcpUrl" | "openrouterApiKey" | "model" | "egressUrl">,
  session: { readonly workerId: string; readonly mcpToken: string; readonly ticketId: string },
): Record<string, string> => ({
  OPENROUTER_API_KEY: config.openrouterApiKey,
  // Where the session fetches its ticket's skills, with its own token (never in the command line).
  PROJECT_OS_SKILLS_URL: `${config.mcpUrl.replace(/\/mcp\/?$/, "")}/tickets/${encodeURIComponent(session.ticketId)}/skills`,
  PROJECT_OS_SKILLS_TOKEN: session.mcpToken,
  PROJECT_OS_MCP_JSON: piMcpJson(config.mcpUrl, session.mcpToken),
  PROJECT_OS_MODEL: config.model,
  PROJECT_OS_PROMPT: workerSessionStart(session.workerId, {
    credentialProxy: config.egressUrl !== undefined,
  }),
  // The proxy takes the session's own MCP token; the person's token stays on the Coordinator.
  ...(config.egressUrl !== undefined && {
    PROJECT_OS_EGRESS_URL: config.egressUrl.replace(/\/+$/, ""),
    PROJECT_OS_EGRESS_TOKEN: session.mcpToken,
  }),
});

/**
 * Starts a Pi session for sandbox tickets on the provider the ticket was assigned to, and
 * reports the pool to the Coordinator. `launch` returns as soon as the sandbox work is kicked
 * off. A launch that cannot even start (a worker type outside the pool, or the runner throwing
 * on kickoff) fails `LaunchFailed`, so the Coordinator queues the ticket again. A session that
 * fails after kickoff is only logged: the ticket stays `assigned` for the health sweep to flag.
 */
export const makeSandboxLauncher = (
  config: SandboxLauncherConfig,
): typeof WorkerLauncher.Service => {
  const byType = new Map<string, SandboxProvider>(
    config.providers.map((p) => [p.workerType, p] as const),
  );
  const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const pool: ReadonlyArray<SandboxPoolEntry> = config.providers.map(
    ({ workerType, maxConcurrent }) => ({
      workerType,
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
      sessionTimeoutSeconds: timeoutSeconds,
    }),
  );
  return {
    pool: Effect.succeed(pool),
    launch: ({ ticketId, workerType, workerId, mcpToken }) =>
      Effect.try({
        try: () => {
          const provider = byType.get(workerType);
          if (provider === undefined) throw new Error(`no ${workerType} provider in the pool`);
          const name = SANDBOX_PROVIDER_OF[provider.workerType];
          config.log(`${name}: launching ${workerId} for ticket ${ticketId}`);
          provider.runner
            .run({
              env: sessionEnv(config, { workerId, mcpToken, ticketId }),
              command: config.egressUrl === undefined ? SESSION_COMMAND : PROXIED_SESSION_COMMAND,
              timeoutSeconds,
            })
            .then(
              ({ exitCode, output }) =>
                config.log(
                  exitCode === 0
                    ? `${name}: ${workerId} finished`
                    : `${name}: ${workerId} exited ${exitCode}: ${output.slice(-500)}`,
                ),
              (e) =>
                config.log(
                  `${name}: ${workerId} failed: ${e instanceof Error ? e.message : String(e)}`,
                ),
            );
        },
        catch: (e) => new LaunchFailed({ message: e instanceof Error ? e.message : String(e) }),
      }),
  };
};

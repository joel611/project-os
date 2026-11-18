import { join } from "node:path";
import { WATCHER_AGENTS, type WatcherAgent } from "@project-os/contracts";
import type { WatcherConfig } from "./config.ts";

export const AGENT_NAMES = WATCHER_AGENTS;
export type AgentName = WatcherAgent;

export const isAgentName = (value: string): value is AgentName =>
  (AGENT_NAMES as readonly string[]).includes(value);

/** Name of the Coordinator in each agent's MCP config; Claude's tool permissions are keyed on it. */
export const MCP_SERVER_NAME = "project-os";

export const CODEX_TOKEN_ENV = "PROJECT_OS_MCP_TOKEN";

/**
 * A file the agent reads its MCP config from. `update` gets the file's current contents (if any),
 * so an agent can add the Coordinator without dropping the user's own entries.
 */
export interface AgentFile {
  readonly path: string;
  readonly update: (existing: string | undefined) => string;
}

export interface AgentLaunch {
  readonly cmd: readonly string[];
  /** Added on top of the Watcher's own environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Written (readable by this user only) before `cmd` runs. */
  readonly files: readonly AgentFile[];
}

/** Skill folders written for this one session: `<root>/<layout>/<slug>/...`. */
export interface InstalledSkills {
  readonly root: string;
  readonly slugs: readonly string[];
}

export interface AgentContext {
  readonly config: WatcherConfig;
  readonly prompt: string;
  readonly configDir: string;
  readonly home: string;
  /** Present only when the ticket's skill set was installed. */
  readonly skills?: InstalledSkills;
}

export interface Agent {
  readonly name: AgentName;
  readonly launch: (ctx: AgentContext) => AgentLaunch;
  /**
   * Where under a session's skills root this agent expects skill folders, so a session sees
   * its own skills and nothing is left in the user's own agent config. Undefined: the agent
   * can't load skills from outside its config, so none are installed.
   */
  readonly skillsLayout?: string;
}

const authorization = (config: WatcherConfig) => `Bearer ${config.secret}`;

export const claudeMcpConfig = (config: WatcherConfig): string =>
  JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: config.mcpUrl,
        headers: { Authorization: authorization(config) },
      },
    },
  });

const claude: Agent = {
  name: "claude",
  // Claude Code loads `.claude/skills/*` from every `--add-dir` directory.
  skillsLayout: ".claude/skills",
  launch: ({ config, prompt, configDir, skills }) => {
    const mcpFile = join(configDir, "mcp.json");
    return {
      cmd: [
        "claude",
        "-p",
        prompt,
        "--mcp-config",
        mcpFile,
        // Headless `-p` cannot prompt, so pre-approve every Coordinator MCP tool (and nothing else).
        "--allowedTools",
        `mcp__${MCP_SERVER_NAME}__*`,
        ...(skills ? ["--add-dir", skills.root] : []),
        ...(config.model ? ["--model", config.model] : []),
      ],
      env: {},
      files: [{ path: mcpFile, update: () => claudeMcpConfig(config) }],
    };
  },
};

type PiMcpFile = { mcpServers?: Record<string, unknown> };

export const piMcpPath = (home: string): string => join(home, ".pi", "agent", "mcp.json");

/** Pi's MCP file without the Coordinator, keeping everything else; undefined if it had none. */
export const withoutPiServer = (existing: string): string | undefined => {
  const current = JSON.parse(existing) as PiMcpFile;
  if (!current.mcpServers || !(MCP_SERVER_NAME in current.mcpServers)) return undefined;
  const { [MCP_SERVER_NAME]: _coordinator, ...others } = current.mcpServers;
  return JSON.stringify({ ...current, mcpServers: others });
};

const pi: Agent = {
  name: "pi",
  skillsLayout: "skills",
  launch: ({ config, prompt, home, skills }) => ({
    cmd: [
      "pi",
      "--print",
      ...(config.model ? ["--model", config.model] : []),
      ...(skills
        ? skills.slugs.flatMap((slug) => ["--skill", join(skills.root, "skills", slug)])
        : []),
      prompt,
    ],
    env: {},
    files: [
      {
        path: piMcpPath(home),
        update: (existing) => {
          const current = existing ? (JSON.parse(existing) as PiMcpFile) : {};
          return JSON.stringify({
            ...current,
            mcpServers: {
              ...current.mcpServers,
              [MCP_SERVER_NAME]: {
                url: config.mcpUrl,
                headers: { Authorization: authorization(config) },
                // `direct` declares the tools to the model; the default hides them behind codemode.
                exposure: "direct",
              },
            },
          });
        },
      },
    ],
  }),
};

const codexOverride = (key: string, value: string) => ["-c", `${key}=${JSON.stringify(value)}`];

const codex: Agent = {
  name: "codex",
  launch: ({ config, prompt }) => {
    const server = `mcp_servers.${MCP_SERVER_NAME}`;
    return {
      cmd: [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        // Headless `exec` cannot prompt: never ask, and pre-approve the Coordinator's MCP tools.
        ...codexOverride("approval_policy", "never"),
        ...codexOverride(`${server}.url`, config.mcpUrl),
        ...codexOverride(`${server}.bearer_token_env_var`, CODEX_TOKEN_ENV),
        ...codexOverride(`${server}.default_tools_approval_mode`, "approve"),
        ...(config.model ? ["--model", config.model] : []),
        prompt,
      ],
      env: { [CODEX_TOKEN_ENV]: config.secret },
      files: [],
    };
  },
};

export const AGENTS: Readonly<Record<AgentName, Agent>> = { claude, pi, codex };

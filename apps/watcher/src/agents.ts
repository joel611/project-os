import { join } from "node:path";
import type { WatcherConfig } from "./config.ts";

export const AGENT_NAMES = ["claude", "pi", "codex"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const isAgentName = (value: string): value is AgentName =>
  (AGENT_NAMES as readonly string[]).includes(value);

/** Name of the Coordinator in each agent's MCP config; Claude's tool permissions are keyed on it. */
export const MCP_SERVER_NAME = "project-os";

/** Env var Codex reads the Coordinator bearer token from, so the secret stays out of `ps`. */
export const CODEX_TOKEN_ENV = "PROJECT_OS_MCP_TOKEN";

/**
 * A file the agent reads its MCP config from. `update` gets the file's current contents (if any),
 * so an agent can add the Coordinator without dropping the user's own entries.
 */
export interface AgentFile {
  readonly path: string;
  readonly update: (existing: string | undefined) => string;
}

/** Everything the Watcher needs to run one headless session on an agent CLI. */
export interface AgentLaunch {
  readonly cmd: readonly string[];
  /** Added on top of the Watcher's own environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Written (readable by this user only) before `cmd` runs. */
  readonly files: readonly AgentFile[];
}

export interface AgentContext {
  readonly config: WatcherConfig;
  readonly prompt: string;
  /** Watcher's private config dir (`~/.config/project-os`). */
  readonly configDir: string;
  readonly home: string;
}

/** One agent CLI the Watcher can drive. Each turns the same config and prompt into its own invocation. */
export interface Agent {
  readonly name: AgentName;
  readonly launch: (ctx: AgentContext) => AgentLaunch;
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
  launch: ({ config, prompt, configDir }) => {
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
        ...(config.model ? ["--model", config.model] : []),
      ],
      env: {},
      files: [{ path: mcpFile, update: () => claudeMcpConfig(config) }],
    };
  },
};

type PiMcpFile = { mcpServers?: Record<string, unknown> };

const pi: Agent = {
  name: "pi",
  launch: ({ config, prompt, home }) => ({
    cmd: ["pi", "--print", ...(config.model ? ["--model", config.model] : []), prompt],
    env: {},
    files: [
      {
        path: join(home, ".pi", "agent", "mcp.json"),
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

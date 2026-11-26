import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import type { PiEvent } from "./events.ts";
import type { PiRun, PiSessionFactory } from "./session.ts";

export interface PiFactoryConfig {
  /** Pi model pattern such as `openrouter/anthropic/claude-sonnet-4.5`; unset uses Pi's default. */
  readonly model?: string;
  /** Skill folders to load for these sessions only. */
  readonly skillPaths?: readonly string[];
}

/**
 * Pi through its SDK. The MCP servers `session/new` lists are registered on the session by an
 * inline extension, so nothing is written to `~/.pi/agent/mcp.json`; Pi's own file is still read,
 * and an entry there with the same name wins.
 */
export const piSessionFactory =
  (config: PiFactoryConfig = {}): PiSessionFactory =>
  async ({ cwd, mcpServers }): Promise<PiRun> => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      additionalSkillPaths: [...(config.skillPaths ?? [])],
      extensionFactories: [
        createMcpExtension(),
        (pi) => {
          for (const [name, server] of Object.entries(mcpServers)) {
            pi.registerMcpServer(name, structuredClone(server) as McpServerConfig);
          }
        },
      ],
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create();
    const resolved = config.model
      ? resolveCliModel({ cliModel: config.model, modelRuntime })
      : undefined;
    if (resolved?.error) throw new Error(resolved.error);
    const { session } = await createAgentSession({
      cwd,
      resourceLoader,
      modelRuntime,
      sessionManager: SessionManager.inMemory(),
      ...(resolved?.model && { model: resolved.model }),
      ...(resolved?.thinkingLevel && { thinkingLevel: resolved.thinkingLevel }),
    });
    // The MCP extension connects its servers when the session starts.
    await session.bindExtensions({});
    return {
      prompt: (text) => session.prompt(text),
      subscribe: (listener) => session.subscribe((event) => listener(event as PiEvent)),
      abort: () => session.abort(),
      dispose: () => session.dispose(),
    };
  };

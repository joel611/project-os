import type { PiEvent } from "./events.ts";
import type { PiMcpServer } from "./mcp.ts";

/** One Pi conversation, as the ACP agent needs it. */
export interface PiRun {
  /** Resolves when Pi has finished the turn, including its tool calls. */
  readonly prompt: (text: string) => Promise<void>;
  readonly subscribe: (listener: (event: PiEvent) => void) => () => void;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
}

export interface PiSessionOptions {
  readonly cwd: string;
  readonly mcpServers: Readonly<Record<string, PiMcpServer>>;
}

export type PiSessionFactory = (options: PiSessionOptions) => Promise<PiRun>;

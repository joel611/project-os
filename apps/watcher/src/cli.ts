import { AGENT_NAMES, type AgentName, isAgentName } from "./agents.ts";

export type Command =
  | {
      readonly kind: "register";
      readonly token: string;
      readonly server?: string;
      readonly name?: string;
      readonly agent?: AgentName;
      readonly model?: string;
    }
  | { readonly kind: "uninstall"; readonly yes: boolean }
  | { readonly kind: "run" }
  | { readonly kind: "help" };

export const USAGE = `Usage:
  project-os-watcher register <code> --server <url> [--name <name>] [--agent claude|pi|codex] [--model <model>]
      Register this computer (code from /register-worker), then run. An admin's
      shared code adds it to the pool for everyone; otherwise it is your personal worker.
      --agent and --model are saved with the registration (default: claude, and the
      agent's own default model).
  project-os-watcher
      Run: poll for your tickets and start an agent session for each.
      WATCHER_AGENT and WATCHER_MODEL override the saved choice for this run.
  project-os-watcher uninstall [--yes]
      Remove what the installer added: stop the Watcher, uninstall the package, delete the
      saved registration and the Coordinator entry in Pi's MCP config. Asks first unless --yes.
  project-os-watcher --help
      Show this help.`;

/** Parses argv after the script name. */
export const parseArgs = (argv: ReadonlyArray<string>): Command => {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "run" };
  if (first === "-h" || first === "--help" || first === "help") return { kind: "help" };
  if (first === "uninstall") {
    const unknown = rest.find((arg) => arg !== "--yes" && arg !== "-y");
    if (unknown !== undefined) throw new Error(`Unexpected argument "${unknown}".\n\n${USAGE}`);
    return { kind: "uninstall", yes: rest.length > 0 };
  }
  if (first !== "register") throw new Error(`Unknown command "${first}".\n\n${USAGE}`);

  let token: string | undefined;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--server" || arg === "--name" || arg === "--agent" || arg === "--model") {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.\n\n${USAGE}`);
      flags[arg.slice(2)] = value;
    } else if (token === undefined) {
      token = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}".\n\n${USAGE}`);
    }
  }
  if (!token) throw new Error(`register needs the code from /register-worker.\n\n${USAGE}`);
  const agent = flags.agent;
  if (agent !== undefined && !isAgentName(agent)) {
    throw new Error(`--agent must be one of ${AGENT_NAMES.join(", ")}.\n\n${USAGE}`);
  }
  return {
    kind: "register",
    token,
    ...(flags.server && { server: flags.server }),
    ...(flags.name && { name: flags.name }),
    ...(agent && { agent }),
    ...(flags.model && { model: flags.model }),
  };
};

import { AGENT_NAMES, type AgentName, isAgentName } from "./agents.ts";

export type Command =
  | {
      readonly kind: "register";
      readonly token: string;
      readonly server?: string;
      readonly name?: string;
      readonly agent?: AgentName;
      readonly model?: string;
      readonly verbose: boolean;
      readonly runLog: boolean;
    }
  | { readonly kind: "uninstall"; readonly yes: boolean }
  | { readonly kind: "run"; readonly verbose: boolean; readonly runLog: boolean }
  | { readonly kind: "help" };

export const USAGE = `Usage:
  project-os-watcher register <code> --server <url> [--name <name>] [--agent claude|pi|codex] [--model <model>] [--verbose]
      Register this computer (code from /register-worker), then run. An admin's
      shared code adds it to the pool for everyone; otherwise it is your personal worker.
      --agent and --model are saved with the registration (default: claude, and the
      agent's own default model).
  project-os-watcher [--verbose] [--no-run-log]
      Run: poll for your tickets and start an agent session for each. Each session's
      transcript (messages, tool calls, errors, secrets masked) is sent to the Coordinator
      so admins and the requester can debug the ticket; --no-run-log (or WATCHER_RUN_LOG=0)
      keeps it on this computer.
      WATCHER_AGENT and WATCHER_MODEL override the saved choice for this run.
      --verbose (-v, or WATCHER_VERBOSE=1) also logs every poll, request and skill install.
      In the config directory, workspaces/repos/ holds one clone of each project repo, and
      each ticket's session starts in workspaces/tickets/<ticket>/, with a worktree of each
      repo on the branch ticket/<ticket>. Once all the PRs a ticket's result names are
      merged, its clean worktrees are removed. A clone or fetch is killed after
      WATCHER_GIT_TIMEOUT_MS (default 10 minutes). The log is also appended to
      logs/watcher.log, and each session's events to its own file in logs/sessions/.
  project-os-watcher uninstall [--yes]
      Remove what the installer added: stop the Watcher, uninstall the package, delete the
      saved registration and the Coordinator entry in Pi's MCP config. Asks first unless --yes.
      Keeps workspaces/ and logs/, which may hold uncommitted work and session logs.
  project-os-watcher --help
      Show this help.`;

/** Parses argv after the script name. */
export const parseArgs = (args: ReadonlyArray<string>): Command => {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const runLog = !args.includes("--no-run-log");
  const [first, ...rest] = args.filter(
    (arg) => arg !== "--verbose" && arg !== "-v" && arg !== "--no-run-log",
  );
  if (first === undefined) return { kind: "run", verbose, runLog };
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
    verbose,
    runLog,
    token,
    ...(flags.server && { server: flags.server }),
    ...(flags.name && { name: flags.name }),
    ...(agent && { agent }),
    ...(flags.model && { model: flags.model }),
  };
};

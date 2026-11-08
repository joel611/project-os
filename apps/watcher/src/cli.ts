export type Command =
  | {
      readonly kind: "register";
      readonly token: string;
      readonly server?: string;
      readonly name?: string;
    }
  | { readonly kind: "run" }
  | { readonly kind: "help" };

export const USAGE = `Usage:
  project-os-watcher register <code> --server <url> [--name <name>]
      Register this computer (code from /register-worker), then run. An admin's
      shared code adds it to the pool for everyone; otherwise it is your personal worker.
  project-os-watcher
      Run: poll for your tickets and start an agent session for each.
      WATCHER_AGENT picks the CLI (claude, pi or codex; default claude), WATCHER_MODEL its model.`;

/** Parses argv after the script name. */
export const parseArgs = (argv: ReadonlyArray<string>): Command => {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "run" };
  if (first === "-h" || first === "--help" || first === "help") return { kind: "help" };
  if (first !== "register") throw new Error(`Unknown command "${first}".\n\n${USAGE}`);

  let token: string | undefined;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--server" || arg === "--name") {
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
  return {
    kind: "register",
    token,
    ...(flags.server && { server: flags.server }),
    ...(flags.name && { name: flags.name }),
  };
};

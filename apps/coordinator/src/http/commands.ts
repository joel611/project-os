import type { AdminActions } from "@project-os/agent-runtime";
import {
  type CommandReply,
  type ConnectionProvider,
  CONNECTION_PROVIDERS,
  type SlashCommand,
} from "@project-os/contracts";
import {
  type Clock,
  type IdGenerator,
  issueWorkerRegistration,
  type KeyValueStore,
  listPersonalWorkers,
  type Person,
  PROVIDER_LABELS,
  REGISTRATION_TTL_SECONDS,
  unregisterWorker,
  UserConnections,
  type WorkerRepository,
} from "@project-os/core";
import { Effect } from "effect";

export interface CommandsConfig {
  /** Discord channel id of the admin channel; admin commands run only there. Unset: refused. */
  readonly adminChannelId?: string;
  /** Discord user ids allowed to run admin commands. Unset: no check. Empty: nobody. */
  readonly adminUserIds?: ReadonlyArray<string>;
  /** The same actions the admin dialogue's tools call. */
  readonly admin: Pick<AdminActions, "createProject">;
  /** Runs account-linking effects (/connect, /disconnect, /connections). Unset: refused. */
  readonly connections?: <A>(effect: Effect.Effect<A, never, UserConnections>) => Promise<A>;
  /** Personal workers (/register-worker, /workers, /unregister-worker). Unset: refused. */
  readonly workers?: WorkersCommandsConfig;
}

export type WorkersEnv = Clock | IdGenerator | KeyValueStore | WorkerRepository;

export interface WorkersCommandsConfig {
  readonly run: <A>(effect: Effect.Effect<A, never, WorkersEnv>) => Promise<A>;
  /** Coordinator URL as the person's computer reaches it (the Watcher registers and polls here). */
  readonly publicUrl: string;
  /** How to install the Watcher. Default `bun install -g @project-os/watcher`. */
  readonly installCommand?: string;
  /** A device that hasn't heartbeat within this reads as offline. */
  readonly staleMs: number;
}

export const DEFAULT_WATCHER_INSTALL = "bun install -g @project-os/watcher";

const privately = (content: string): CommandReply => ({ content, ephemeral: true });

/**
 * Runs a slash command forwarded by a Channel Adapter. Admin commands are deterministic
 * shortcuts to the admin dialogue's actions, held to the same admin channel and user list.
 * Account commands work anywhere and always answer privately.
 */
export const runCommand = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  switch (command.command) {
    case "project-create":
      return projectCreate(command, config);
    case "connect":
    case "disconnect":
    case "connections":
      return accountCommand(command, config);
    case "register-worker":
    case "workers":
    case "unregister-worker":
      return workerCommand(command, config);
  }
};

const projectCreate = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  const inAdminChannel =
    config.adminChannelId !== undefined &&
    command.channelType === "discord" &&
    command.channelId === config.adminChannelId &&
    command.threadId === undefined;
  if (!inAdminChannel) return privately(`/${command.command} only works in the admin channel.`);
  if (config.adminUserIds && !config.adminUserIds.includes(command.sender.id)) {
    return privately("Not authorized: you are not on the admin list.");
  }

  const name = command.options.name?.trim();
  if (!name) return privately("Usage: /project-create name:<project name> [instructions:<text>]");
  const instructions = command.options.instructions?.trim();
  const content = await config.admin.createProject({
    name,
    ...(instructions ? { customInstructions: instructions } : {}),
  });
  return { content, ephemeral: false };
};

const withConnections = <A>(f: (c: UserConnections["Service"]) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    return yield* f(yield* UserConnections);
  });

const isProvider = (value: string | undefined): value is ConnectionProvider =>
  (CONNECTION_PROVIDERS as ReadonlyArray<string | undefined>).includes(value);

const accountCommand = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  if (!config.connections) return privately("Account linking is not configured here.");
  const person: Person = {
    channelType: command.channelType,
    id: command.sender.id,
    ...(command.sender.name ? { name: command.sender.name } : {}),
  };

  if (command.command === "connections") {
    const linked = await config.connections(withConnections((c) => c.list(person)));
    if (linked.length === 0) {
      return privately("You haven't linked any accounts. Run `/connect` to link Google or GitHub.");
    }
    return privately(
      `Linked: ${linked.map((a) => PROVIDER_LABELS[a.provider]).join(", ")}. I use these when working on what you ask for.`,
    );
  }

  const provider = command.options.provider?.trim().toLowerCase();
  if (!isProvider(provider)) {
    return privately(`Usage: /${command.command} provider:<${CONNECTION_PROVIDERS.join("|")}>`);
  }
  const label = PROVIDER_LABELS[provider];

  if (command.command === "disconnect") {
    const removed = await config.connections(
      withConnections((c) => c.disconnect(person, provider)),
    );
    return privately(removed ? `Disconnected ${label}.` : `You had no ${label} account linked.`);
  }

  const url = await config.connections(
    withConnections((c) =>
      c.connectUrl(person, provider).pipe(Effect.orElseSucceed((): string | null => null)),
    ),
  );
  if (!url) return privately(`${label} linking is not configured here.`);
  return privately(
    `Open this link to connect your ${label} account (works once, for 10 minutes): ${url}\nI'll then use your own ${label} access for what you ask, so I only see what you can see.`,
  );
};

const personOf = (command: SlashCommand): Person => ({
  channelType: command.channelType,
  id: command.sender.id,
  ...(command.sender.name ? { name: command.sender.name } : {}),
});

/** Quotes a value for a POSIX shell line (names may contain spaces). */
const shellQuote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** The line a person pastes on their computer: install the Watcher, then register and run it. */
export const watcherCommandLine = (
  config: WorkersCommandsConfig,
  token: string,
  name?: string,
): string =>
  [
    config.installCommand ?? DEFAULT_WATCHER_INSTALL,
    "&&",
    "project-os-watcher register",
    token,
    "--server",
    shellQuote(config.publicUrl.replace(/\/+$/, "")),
    ...(name ? ["--name", shellQuote(name)] : []),
  ].join(" ");

const workerCommand = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  const workers = config.workers;
  if (!workers) return privately("Personal workers are not configured here.");
  const person = personOf(command);

  if (command.command === "register-worker") {
    const name = command.options.name?.trim() || undefined;
    const { token } = await workers.run(issueWorkerRegistration(person));
    const minutes = Math.round(REGISTRATION_TTL_SECONDS / 60);
    return privately(
      [
        `Run this on the computer that should work on your tickets (the code works once, for ${minutes} minutes):`,
        "```sh",
        watcherCommandLine(workers, token, name),
        "```",
        "It needs Bun and Claude Code. It registers the computer to you, then keeps running and picks up only the tickets you start. To start it again later, run `project-os-watcher`.",
        "While it's offline, your tickets go to the shared cloud worker.",
      ].join("\n"),
    );
  }

  if (command.command === "workers") {
    const mine = await workers.run(listPersonalWorkers(person, workers.staleMs));
    if (mine.length === 0) {
      return privately(
        "You have no registered workers, so your tickets go to the shared cloud worker. Run `/register-worker` to use your own computer.",
      );
    }
    const lines = mine.map(
      ({ worker, status }) =>
        `- **${worker.name ?? worker.id}** (\`${worker.id}\`): ${status}${
          status === "online" ? "" : `, last seen ${seen(worker.lastSeenAt)}`
        }`,
    );
    return privately(["Your workers:", ...lines].join("\n"));
  }

  const which = command.options.worker?.trim();
  if (!which) return privately("Usage: /unregister-worker worker:<name or id>");
  const removed = await workers.run(unregisterWorker(person, which));
  return privately(
    removed
      ? `Removed ${removed.name ?? removed.id}. Its Watcher can no longer pick up tickets.`
      : `You have no worker called "${which}". Run \`/workers\` to see yours.`,
  );
};

const seen = (iso: string) =>
  Date.parse(iso) <= 0 ? "never" : iso.replace("T", " ").slice(0, 16) + " UTC";

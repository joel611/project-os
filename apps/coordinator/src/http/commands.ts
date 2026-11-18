import type { AdminActions } from "@project-os/agent-runtime";
import {
  type CommandReply,
  type ConnectionProvider,
  CONNECTION_PROVIDERS,
  detectSource,
  type SlashCommand,
  suggestAlias,
  WATCHER_AGENTS,
} from "@project-os/contracts";
import {
  addSource,
  type AuditLogRepository,
  type Clock,
  type IdGenerator,
  issueWorkerRegistration,
  type KeyValueStore,
  listPersonalWorkers,
  listSharedWorkers,
  type Person,
  type ProjectRepository,
  ProjectSourceRepository,
  PROVIDER_LABELS,
  REGISTRATION_TTL_SECONDS,
  unregisterSharedWorker,
  unregisterWorker,
  UserConnections,
  type Worker,
  workerLabel,
  type WorkerRepository,
  sourceUrl,
} from "@project-os/core";
import { Effect } from "effect";
import { installLine, type ScriptConfig } from "./watcher-install.ts";

export interface CommandsConfig {
  /** Discord channel id of the admin channel; admin commands run only there. Unset: refused. */
  readonly adminChannelId?: string;
  /** Discord user ids allowed to run admin commands. Unset: no check. Empty: nobody. */
  readonly adminUserIds?: ReadonlyArray<string>;
  readonly admin: Pick<AdminActions, "createProject">;
  /** Runs account-linking effects (/connect, /disconnect, /connections). Unset: refused. */
  readonly connections?: <A>(effect: Effect.Effect<A, never, UserConnections>) => Promise<A>;
  /**
   * Registered devices (/register-worker, /workers, /unregister-worker): personal ones for
   * anyone, shared ones (`shared:True`) for admins in the admin channel. Unset: refused.
   */
  readonly workers?: WorkersCommandsConfig;
  /** The web dashboard's URL (`WEB_ORIGIN`), which /dashboard points people to. Unset: refused. */
  readonly dashboardUrl?: string;
  /** Links sources to the project of the channel the command ran in (/source-add). Unset: refused. */
  readonly sources?: <A>(effect: Effect.Effect<A, never, SourcesEnv>) => Promise<A>;
}

export type SourcesEnv = Clock | IdGenerator | ProjectRepository | ProjectSourceRepository;

export type WorkersEnv =
  | AuditLogRepository
  | Clock
  | IdGenerator
  | KeyValueStore
  | WorkerRepository;

export interface WorkersCommandsConfig {
  readonly run: <A>(effect: Effect.Effect<A, never, WorkersEnv>) => Promise<A>;
  readonly publicUrl: string;
  readonly installCommand?: string;
  readonly staleMs: number;
}

export const watcherScriptConfig = (config: WorkersCommandsConfig): ScriptConfig => ({
  server: config.publicUrl,
  ...(config.installCommand && { installCommand: config.installCommand }),
});

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
    case "source-add":
      return sourceAdd(command, config);
    case "dashboard":
      return dashboardCommand(command, config);
  }
};

const adminRefusal = (
  command: SlashCommand,
  config: CommandsConfig,
  what = `/${command.command}`,
): CommandReply | undefined => {
  const inAdminChannel =
    config.adminChannelId !== undefined &&
    command.channelType === "discord" &&
    command.channelId === config.adminChannelId &&
    command.threadId === undefined;
  if (!inAdminChannel) return privately(`${what} only works in the admin channel.`);
  if (config.adminUserIds && !config.adminUserIds.includes(command.sender.id)) {
    return privately("Not authorized: you are not on the admin list.");
  }
  return undefined;
};

const projectCreate = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  const refused = adminRefusal(command, config);
  if (refused) return refused;

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
      return privately(
        "You haven't linked any accounts. Run `/connect` to link Google, GitHub or ClickUp.",
      );
    }
    return privately(
      `Linked: ${linked.map((a) => `${PROVIDER_LABELS[a.provider]}${a.displayIdentity ? ` (${a.displayIdentity})` : ""}`).join(", ")}. I use these when working on what you ask for.`,
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

/**
 * /dashboard: where to see your own Tickets. Signing in there takes the Google account linked
 * with /connect, so without one it hands out the Google connect link first.
 */
const dashboardCommand = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  if (!config.dashboardUrl) return privately("The dashboard isn't set up here.");
  const login = `${config.dashboardUrl.replace(/\/+$/, "")}/login`;
  if (!config.connections) {
    return privately(`The dashboard is at ${login}, but account linking isn't set up here.`);
  }
  const person: Person = {
    channelType: command.channelType,
    id: command.sender.id,
    ...(command.sender.name ? { name: command.sender.name } : {}),
  };
  const linked = await config.connections(withConnections((c) => c.list(person)));
  if (linked.some((a) => a.provider === "google")) {
    return privately(
      `Open ${login} and choose **Sign in with Google**, with the Google account you linked. You'll see the tickets you started or took part in.`,
    );
  }
  const url = await config.connections(
    withConnections((c) =>
      c.connectUrl(person, "google").pipe(Effect.orElseSucceed((): string | null => null)),
    ),
  );
  if (!url) {
    return privately(
      "Signing in to the dashboard takes a linked Google account, and Google linking isn't set up here.",
    );
  }
  return privately(
    [
      `To see your tickets on the dashboard, first link your Google account (this link works once, for 10 minutes): ${url}`,
      `Then open ${login} and choose **Sign in with Google**, with that same account.`,
      "Linking also lets me use your own Google Drive access for what you ask.",
    ].join("\n"),
  );
};

const personOf = (command: SlashCommand): Person => ({
  channelType: command.channelType,
  id: command.sender.id,
});

const workerCommand = async (
  command: SlashCommand,
  config: CommandsConfig,
): Promise<CommandReply> => {
  const workers = config.workers;
  if (!workers) return privately("Registered workers are not configured here.");
  const person = personOf(command);
  const shared = command.options.shared === "true";
  if (shared) {
    const refused = adminRefusal(command, config, `/${command.command} shared:True`);
    if (refused) return refused;
  }

  if (command.command === "register-worker") {
    const name = command.options.name?.trim() || undefined;
    const agent = command.options.agent?.trim() || undefined;
    const model = command.options.model?.trim() || undefined;
    if (agent !== undefined && !(WATCHER_AGENTS as readonly string[]).includes(agent)) {
      return privately(`agent must be one of ${WATCHER_AGENTS.join(", ")}.`);
    }
    const { token } = await workers.run(issueWorkerRegistration(person, { shared }));
    const minutes = Math.round(REGISTRATION_TTL_SECONDS / 60);
    const choice = agent
      ? `It runs sessions on ${agent} (${model ? `model ${model}` : "the agent's default model"}) without asking.`
      : `The script asks which agent and model to use (Enter keeps the agent's default model).`;
    return privately(
      [
        shared
          ? `Run this on the computer that should join the shared pool (the code works once, for ${minutes} minutes):`
          : `Run this on the computer that should work on your tickets (the code works once, for ${minutes} minutes):`,
        "```sh",
        installLine(watcherScriptConfig(workers), token, {
          name,
          agent,
          model,
          yes: agent !== undefined,
        }),
        "```",
        shared
          ? `It needs Bun and one agent CLI (Claude Code, Pi or Codex). ${choice} It registers the computer as a shared worker, then keeps running and picks up tickets from anyone without their own worker online, one at a time. To start it again later, run \`project-os-watcher\`.`
          : `It needs Bun and one agent CLI (Claude Code, Pi or Codex). ${choice} It registers the computer to you, then keeps running and picks up only the tickets you start. To start it again later, run \`project-os-watcher\`.`,
        "To remove it from that computer later, run `project-os-watcher uninstall`.",
        shared
          ? "Remove it with `/unregister-worker shared:True`."
          : "While it's offline, your tickets go to the shared pool.",
      ].join("\n"),
    );
  }

  if (command.command === "workers") {
    const mine = shared ? [] : await workers.run(listPersonalWorkers(person, workers.staleMs));
    const pool = await workers.run(listSharedWorkers(workers.staleMs));
    const sharedLines = pool.length === 0 ? [] : ["Shared workers:", ...pool.map(workerLine)];
    if (shared) {
      return privately(
        pool.length === 0
          ? "There are no shared workers. Add one with `/register-worker shared:True`."
          : sharedLines.join("\n"),
      );
    }
    if (mine.length === 0) {
      return privately(
        [
          "You have no registered workers, so your tickets go to the shared pool. Run `/register-worker` to use your own computer.",
          ...sharedLines,
        ].join("\n"),
      );
    }
    return privately(["Your workers:", ...mine.map(workerLine), ...sharedLines].join("\n"));
  }

  const which = command.options.worker?.trim();
  if (!which) return privately("Usage: /unregister-worker worker:<name or id> [shared:True]");
  const removed = await workers.run(
    shared ? unregisterSharedWorker(which, person) : unregisterWorker(person, which),
  );
  if (removed) {
    return privately(`Removed ${workerLabel(removed)}. Its Watcher can no longer pick up tickets.`);
  }
  return privately(
    shared
      ? `There is no shared worker called "${which}". Run \`/workers shared:True\` to see them.`
      : `You have no worker called "${which}". Run \`/workers\` to see yours.`,
  );
};

const workerLine = ({ worker, status }: { readonly worker: Worker; readonly status: string }) =>
  `- **${workerLabel(worker)}** (\`${worker.id}\`): ${status}${
    status === "online" ? "" : `, last seen ${seen(worker.lastSeenAt)}`
  }`;

const seen = (iso: string) =>
  Date.parse(iso) <= 0 ? "never" : iso.replace("T", " ").slice(0, 16) + " UTC";

const SOURCE_LABELS = {
  github_repo: "GitHub repo",
  google_drive_folder: "Google Drive folder",
} as const;

/**
 * Links a GitHub repo or Google Drive folder to the project whose channel (or thread) the
 * command ran in. The link is read the same way the dashboard reads it. A repo's alias defaults
 * to its name; a Drive folder id says nothing, so it needs one.
 */
const sourceAdd = async (command: SlashCommand, config: CommandsConfig): Promise<CommandReply> => {
  if (!config.sources) return privately("Linking sources is not configured here.");
  const usage =
    "Usage: /source-add link:<GitHub repo or Google Drive folder> [alias:<name>] [description:<text>]";
  const detected = detectSource(command.options.link ?? "");
  if (!detected) {
    return privately(`That isn't a GitHub repo or Google Drive folder link.\n${usage}`);
  }
  const alias = command.options.alias?.trim() || suggestAlias(detected);
  if (!alias) {
    return privately(
      "A Drive folder link doesn't say what's in it, so give it an alias, like `alias:design-docs`.",
    );
  }
  const description = command.options.description?.trim() || undefined;
  const label = SOURCE_LABELS[detected.type];

  return config.sources(
    Effect.gen(function* () {
      const channel = yield* (yield* ProjectSourceRepository).findByExternal(
        "discord_channel",
        command.channelId,
      );
      if (!channel || channel.status !== "active") {
        return privately("/source-add only works in a project's channel.");
      }
      return yield* addSource({
        projectId: channel.projectId,
        type: detected.type,
        externalId: detected.externalId,
        name: detected.name,
        alias,
        description,
      }).pipe(
        Effect.map((source) =>
          privately(
            `Linked ${label} <${sourceUrl(source)}> to this project as \`${source.alias}\`. ` +
              "Workers can now find it by that name.",
          ),
        ),
        Effect.catchTags({
          SourceAlreadyLinked: (e) =>
            Effect.succeed(
              privately(
                e.projectId === channel.projectId
                  ? `That ${label} is already linked to this project.`
                  : `That ${label} is already linked to another project.`,
              ),
            ),
          SourceAliasTaken: (e) =>
            Effect.succeed(
              privately(
                `This project already has a source called \`${e.alias}\`. Pick another with \`alias:\`.`,
              ),
            ),
          InvalidSourceAlias: (e) => Effect.succeed(privately(e.message)),
        }),
        // The channel's project exists (its source points at it), and no default reply channel
        // is set, so ProjectNotFound and SourceNotFound can't happen.
        Effect.orDie,
      );
    }),
  );
};

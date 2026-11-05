import type { AdminActions } from "@project-os/agent-runtime";
import { PROJECT_SOURCE_TYPES, type ProjectSourceType } from "@project-os/contracts";
import {
  addSource,
  CHANNEL_SOURCE_TYPES,
  createProject,
  createProjectWithChannel,
  type ChannelGateway,
  getTicket,
  setDefaultChannel,
  type Clock,
  type IdGenerator,
  type ProjectRepository,
  type ProjectSourceRepository,
  type TicketRepository,
} from "@project-os/core";
import { Effect } from "effect";

/** Ports the admin actions need from the provider Layer. */
export type AdminEnv =
  | ChannelGateway
  | Clock
  | IdGenerator
  | ProjectRepository
  | ProjectSourceRepository
  | TicketRepository;

/** Short names the admin dialogue may use, plus the full source types. */
const SOURCE_TYPES: Record<string, ProjectSourceType> = {
  ...CHANNEL_SOURCE_TYPES,
  ...Object.fromEntries(PROJECT_SOURCE_TYPES.map((t) => [t, t])),
};

/** Failures become text the model can relay, never exceptions out of a tool call. */
const asText = <E extends { readonly _tag: string }>(effect: Effect.Effect<string, E, AdminEnv>) =>
  effect.pipe(Effect.catch((e) => Effect.succeed(`Failed: ${e._tag} ${JSON.stringify(e)}`)));

/**
 * The Coordinator actions behind the admin dialogue's tools (#14's `AdminActions`), each
 * running the matching core use case. `run` executes against the provider Layer.
 */
export const makeAdminActions = (deps: {
  readonly run: <A>(effect: Effect.Effect<A, unknown, AdminEnv>) => Promise<A>;
  /** Org that new projects belong to (POC: one org). */
  readonly orgId: string;
  /**
   * Whether `create_project` also creates the project's Discord channel (default true).
   * When false, projects are created alone and channels are linked with set_default_channel.
   */
  readonly autoCreateChannel?: boolean;
}): AdminActions => ({
  createProject: ({ name, customInstructions, createChannel }) => {
    const input = {
      orgId: deps.orgId,
      name,
      ...(customInstructions === undefined ? {} : { customInstructions }),
    };
    const created = (p: { readonly name: string; readonly id: string }) =>
      `Created project "${p.name}" (id ${p.id}).`;
    if (createChannel === false || deps.autoCreateChannel === false) {
      return deps.run(asText(createProject(input).pipe(Effect.map(created))));
    }
    return deps.run(
      asText(
        createProjectWithChannel(input).pipe(
          Effect.map(({ project, source, channelError }) =>
            source
              ? `${created(project)} Created channel ${source.name} (${source.externalId}) ` +
                `as its reply channel.`
              : `${created(project)} Could not create its channel (${channelError}); ` +
                `link an existing one with set_default_channel.`,
          ),
        ),
      ),
    );
  },
  addSource: ({ projectId, type, externalId }) => {
    const sourceType = SOURCE_TYPES[type];
    if (!sourceType) {
      return Promise.resolve(
        `Unknown source type "${type}". Use one of: ${Object.keys(SOURCE_TYPES).join(", ")}.`,
      );
    }
    return deps.run(
      asText(
        addSource({ projectId, type: sourceType, externalId, name: externalId }).pipe(
          Effect.map((s) => `Linked ${s.type} ${s.externalId} to project ${s.projectId}.`),
        ),
      ),
    );
  },
  setDefaultChannel: ({ projectId, externalId }) =>
    deps.run(
      asText(
        setDefaultChannel({ projectId, externalId }).pipe(
          Effect.map(
            (s) => `Default reply channel for project ${s.projectId} is now ${s.externalId}.`,
          ),
        ),
      ),
    ),
  ticketStatus: ({ ticketId }) =>
    deps.run(
      asText(
        getTicket({ ticketId, eventLimit: 1 }).pipe(
          Effect.map(({ ticket }) => `Ticket ${ticket.id} "${ticket.title}": ${ticket.status}`),
        ),
      ),
    ),
});

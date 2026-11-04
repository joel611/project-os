import type { AdminActions } from "@project-os/agent-runtime";
import {
  addSource,
  createProject,
  getTicket,
  setDefaultChannel,
  type Clock,
  type IdGenerator,
  type ProjectRepository,
  type ProjectSourceRepository,
  type ProjectSourceType,
  type TicketRepository,
} from "@project-os/core";
import { Effect } from "effect";

/** Ports the admin actions need from the provider Layer. */
export type AdminEnv =
  | Clock
  | IdGenerator
  | ProjectRepository
  | ProjectSourceRepository
  | TicketRepository;

/** Short names the admin dialogue may use, plus the full source types. */
const SOURCE_TYPES: Record<string, ProjectSourceType> = {
  discord: "discord_channel",
  email: "email_address",
  discord_channel: "discord_channel",
  email_address: "email_address",
  clickup_list: "clickup_list",
  google_drive_folder: "google_drive_folder",
  github_repo: "github_repo",
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
}): AdminActions => ({
  createProject: ({ name, customInstructions }) =>
    deps.run(
      asText(
        createProject({
          orgId: deps.orgId,
          name,
          ...(customInstructions === undefined ? {} : { customInstructions }),
        }).pipe(Effect.map((p) => `Created project "${p.name}" (id ${p.id}).`)),
      ),
    ),
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

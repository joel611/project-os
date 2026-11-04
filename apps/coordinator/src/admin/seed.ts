import {
  createProject,
  ProjectRepository,
  ProjectSourceRepository,
  setDefaultChannel,
} from "@project-os/core";
import { Effect } from "effect";

export interface SeedInput {
  readonly orgId: string;
  readonly projectName: string;
  /** Discord channel that is the project's source and default reply channel. */
  readonly discordChannelId: string;
}

/**
 * Seeds a project and its Discord channel (default response) so the POC runs before admin
 * chat works. Idempotent: the project is matched by name, the source by channel id. The org
 * must already exist (`ensureOrg`). Fails with `SourceAlreadyLinked` if the channel belongs
 * to another project.
 */
export const seedDefaults = (input: SeedInput) =>
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const sources = yield* ProjectSourceRepository;

    const found = (yield* projects.list).find((p) => p.name === input.projectName);
    const project =
      found ?? (yield* createProject({ orgId: input.orgId, name: input.projectName }));

    const linked = yield* sources.findByExternal("discord_channel", input.discordChannelId);
    // Links the channel if new, refuses another project's, else just flags it as default.
    const source = yield* setDefaultChannel({
      projectId: project.id,
      externalId: input.discordChannelId,
    });

    return { project, source, created: { project: !found, source: !linked } };
  });

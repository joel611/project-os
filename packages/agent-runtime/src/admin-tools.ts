import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";

/**
 * Coordinator actions the admin dialogue may take. The composition root implements each
 * by running the matching core use case; each returns text for the model to relay.
 */
export interface AdminActions {
  /** Creates the project and, unless `createChannel` is false, its own Discord channel. */
  readonly createProject: (args: {
    readonly name: string;
    readonly customInstructions?: string | undefined;
    readonly createChannel?: boolean | undefined;
  }) => Promise<string>;
  readonly addSource: (args: {
    readonly projectId: string;
    readonly type: string;
    readonly externalId: string;
  }) => Promise<string>;
  readonly setDefaultChannel: (args: {
    readonly projectId: string;
    readonly externalId: string;
  }) => Promise<string>;
  readonly ticketStatus: (args: { readonly ticketId: string }) => Promise<string>;
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/**
 * Pi extension: Coordinator actions as tools. No messaging tools by design: the model can
 * ask the Coordinator to create a project's channel, but never posts to channels itself.
 */
export const makeAdminExtension = (actions: AdminActions) =>
  defineExtension({
    name: "project-os-admin",
    tools: [
      defineTool({
        name: "create_project",
        description:
          "Create a Project. By default this also creates a new Discord channel for it and " +
          "makes that the project's reply channel. Pass createChannel=false only when the " +
          "admin wants to link an existing channel instead (then call set_default_channel).",
        parameters: obj({
          name: str(),
          customInstructions: opt(str()),
          createChannel: opt(bool()),
        }),
        execute: async (args) => text(await actions.createProject(args)),
      }),
      defineTool({
        name: "add_source",
        description: "Link a channel (e.g. a Discord channel) to a Project as a source.",
        parameters: obj({ projectId: str(), type: str(), externalId: str() }),
        execute: async (args) => text(await actions.addSource(args)),
      }),
      defineTool({
        name: "set_default_channel",
        description: "Set the channel where a Project's replies are posted.",
        parameters: obj({ projectId: str(), externalId: str() }),
        execute: async (args) => text(await actions.setDefaultChannel(args)),
      }),
      defineTool({
        name: "ticket_status",
        description: "Get the status of a Ticket.",
        parameters: obj({ ticketId: str() }),
        execute: async (args) => text(await actions.ticketStatus(args)),
      }),
    ],
  });

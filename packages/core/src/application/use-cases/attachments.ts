import {
  ChannelType,
  type AttachmentRef,
  type InboundMessage,
  type TicketAttachment,
} from "@project-os/contracts";
import { Effect, Schema } from "effect";
import { ChannelGateway, TicketRepository } from "../ports/index.ts";

/** Where a message with files lives, so its fresh download links can be fetched again later. */
export interface AttachmentMessageRef {
  readonly channelId: string;
  readonly messageId: string;
}

export interface AttachmentsPayload {
  readonly attachments: ReadonlyArray<AttachmentRef>;
  readonly message: AttachmentMessageRef;
}

/**
 * The TicketEvent payload fields for a message's files: refs without the expiring CDN link, plus
 * the message that holds them. Empty when the message has none.
 */
export const attachmentsPayload = (message: InboundMessage): Partial<AttachmentsPayload> => {
  if (!message.attachments || message.attachments.length === 0) return {};
  return {
    attachments: message.attachments.map(({ id, filename, contentType, size }) => ({
      id,
      filename,
      contentType,
      size,
    })),
    // In a thread the message lives in the thread, whose id is a channel id to the platform.
    message: { channelId: message.threadId ?? message.channelId, messageId: message.externalId },
  };
};

/** Reads `attachmentsPayload` back off an event payload; undefined when it carries no files. */
export const readAttachmentsPayload = (payload: unknown): AttachmentsPayload | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { attachments, message } = payload as Record<string, unknown>;
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  if (typeof message !== "object" || message === null) return undefined;
  const { channelId, messageId } = message as Record<string, unknown>;
  if (typeof channelId !== "string" || typeof messageId !== "string") return undefined;
  return {
    attachments: attachments as AttachmentsPayload["attachments"],
    message: { channelId, messageId },
  };
};

/**
 * Every file people sent on a ticket, oldest first, each with a fresh download link read from
 * the message that carried it. A message that can't be read (deleted, no access) still lists
 * its files, with `url: null` and the reason.
 */
export const listTicketAttachments = (ticketId: string) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const gateway = yield* ChannelGateway;
    const events = yield* tickets.listEvents(ticketId);
    const out: Array<typeof TicketAttachment.Type> = [];
    for (const event of events) {
      const found = readAttachmentsPayload(event.payload);
      const channelType = (event.payload as { channelType?: unknown } | null)?.channelType;
      if (!found || !Schema.is(ChannelType)(channelType)) continue;
      const resolved = yield* gateway
        .resolveAttachments({ channelType, ...found.message })
        .pipe(Effect.result);
      const fresh =
        resolved._tag === "Success"
          ? new Map(resolved.success.attachments.map((a) => [a.id, a.url]))
          : undefined;
      for (const ref of found.attachments) {
        const url = fresh?.get(ref.id);
        out.push({
          eventId: event.id,
          ...ref,
          url: url ?? null,
          ...(url === undefined && {
            error:
              resolved._tag === "Failure"
                ? `Could not read the message: ${resolved.failure.message}`
                : "The file is no longer on the message.",
          }),
        });
      }
    }
    return out;
  });

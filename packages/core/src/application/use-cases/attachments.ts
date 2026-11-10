import type { AttachmentRef, InboundMessage } from "@project-os/contracts";

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

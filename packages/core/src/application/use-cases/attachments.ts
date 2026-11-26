import {
  ChannelType,
  type AttachmentRef,
  type InboundMessage,
  type TicketAttachment,
} from "@project-os/contracts";
import { Data, Effect, Schema } from "effect";
import {
  type AssetObject,
  AssetStore,
  AssetStoreFailed,
  ChannelGateway,
  IdGenerator,
  TicketRepository,
} from "../ports/index.ts";
import { ticketChannel } from "./channels.ts";
import { appendEvent } from "./tickets.ts";

/** Where a message with files lives, so its fresh download links can be fetched again later. */
export interface AttachmentMessageRef {
  readonly channelId: string;
  readonly messageId: string;
}

export interface AttachmentsPayload {
  readonly attachments: ReadonlyArray<AttachmentRef>;
  /** Absent on files a Worker attached: they are only ever read from storage. */
  readonly message?: AttachmentMessageRef;
}

/** Hosts the Coordinator will download a message's files from (Discord's CDN). */
export const DEFAULT_ATTACHMENT_HOSTS: ReadonlyArray<string> = [
  "cdn.discordapp.com",
  "media.discordapp.net",
];

/** Largest file copied into storage; bigger ones stay on the Discord link only. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface AttachmentStorageConfig {
  /** Hosts a file may be downloaded from. Default: Discord's CDN. */
  readonly hosts?: ReadonlyArray<string>;
  /**
   * Largest file kept in storage, for files from a message and for a Worker's uploads alike.
   * Default 100 MB.
   */
  readonly maxBytes?: number;
}

const maxBytesOf = (config: AttachmentStorageConfig): number =>
  config.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

/** The signature on a download or upload link is missing, wrong or past its expiry. */
export class AssetLinkInvalid extends Data.TaggedError("AssetLinkInvalid")<{
  readonly key: string;
}> {}

/** Nothing is stored under the key of a validly signed download link. */
export class AssetNotFound extends Data.TaggedError("AssetNotFound")<{
  readonly key: string;
}> {}

/** An upload is bigger than the configured limit. */
export class AttachmentTooLarge extends Data.TaggedError("AttachmentTooLarge")<{
  readonly size: number;
  readonly maxBytes: number;
}> {}

/** Where a stored file is addressed: the parts of its key, as they appear in its link. */
export interface AttachmentAddress {
  readonly ticketId: string;
  readonly attachmentId: string;
  readonly filename: string;
}

/** A signed link's `exp` and `sig` query values; `expires` is NaN when `exp` was absent or bad. */
export interface LinkSignature {
  readonly expires: number;
  readonly sig: string;
}

const safeName = (filename: string): string => {
  const cleaned = filename
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 100);
  return cleaned === "" ? "file" : cleaned;
};

/** Storage key of an attachment: `<ticketId>/<attachmentId>/<safe filename>`. */
export const assetKey = (
  ticketId: string,
  attachment: { readonly id: string; readonly filename: string },
): string => `${ticketId}/${attachment.id}/${safeName(attachment.filename)}`;

/**
 * The TicketEvent payload fields for a message's files: refs without the expiring CDN link, plus
 * the message that holds them. Empty when the message has none. `stored` lists the ids already
 * copied into storage.
 */
export const attachmentsPayload = (
  message: InboundMessage,
  stored: ReadonlySet<string> = new Set(),
): Partial<AttachmentsPayload> => {
  if (!message.attachments || message.attachments.length === 0) return {};
  return {
    attachments: message.attachments.map(({ id, filename, contentType, size }) => ({
      id,
      filename,
      contentType,
      size,
      ...(stored.has(id) && { stored: true }),
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
  const refs = attachments as AttachmentsPayload["attachments"];
  if (typeof message === "object" && message !== null) {
    const { channelId, messageId } = message as Record<string, unknown>;
    if (typeof channelId === "string" && typeof messageId === "string") {
      return { attachments: refs, message: { channelId, messageId } };
    }
  }
  // No source message: only files already in storage can be listed.
  return refs.every((ref) => ref.stored) ? { attachments: refs } : undefined;
};

/** The payload must be an object: callers have read attachments off it already. */
const channelTypeOf = (payload: object): ChannelType | undefined => {
  const { channelType } = payload as Record<string, unknown>;
  return Schema.is(ChannelType)(channelType) ? channelType : undefined;
};

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

/**
 * Copies a message's files into storage, three at a time. A file is skipped (and stays on its
 * Discord link) when its host isn't allowed, it is over the size limit, or the copy fails; one
 * bad file never stops the ticket. Returns the ids that were stored.
 */
export const storeAttachments = (
  ticketId: string,
  message: InboundMessage,
  config: AttachmentStorageConfig = {},
) =>
  Effect.gen(function* () {
    const store = yield* AssetStore;
    const hosts = config.hosts ?? DEFAULT_ATTACHMENT_HOSTS;
    const maxBytes = maxBytesOf(config);
    const stored = new Set<string>();
    yield* Effect.forEach(
      message.attachments ?? [],
      (file) => {
        const host = hostOf(file.url);
        if (host === undefined || !hosts.includes(host) || file.size > maxBytes) return Effect.void;
        return store
          .ingest({
            key: assetKey(ticketId, file),
            url: file.url,
            contentType: file.contentType,
            size: file.size,
            maxBytes,
          })
          .pipe(
            Effect.map(() => void stored.add(file.id)),
            Effect.catchTag("AssetStoreFailed", (err) =>
              Effect.logWarning(`could not store attachment ${file.id}`, err.message),
            ),
          );
      },
      { concurrency: 3 },
    );
    return stored as ReadonlySet<string>;
  });

/**
 * Every file people sent on a ticket, oldest first, each with a download link. A file copied
 * into storage gets a signed Coordinator link that outlives the Discord message. The rest get a
 * fresh link read from the message that carried them; a message that can't be read (deleted, no
 * access) still lists its files, with `url: null` and the reason.
 */
export const listTicketAttachments = (ticketId: string) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const gateway = yield* ChannelGateway;
    const store = yield* AssetStore;
    const events = yield* tickets.listEvents(ticketId);
    const out: Array<typeof TicketAttachment.Type> = [];
    for (const event of events) {
      const found = readAttachmentsPayload(event.payload);
      if (!found) continue;
      const channelType = channelTypeOf(event.payload as object);
      // A message-sourced event needs a known channel; a Worker's upload has no source message.
      if (found.message !== undefined && channelType === undefined) continue;
      const links = new Map<string, string>();
      for (const ref of found.attachments) {
        const link = ref.stored ? yield* store.link(assetKey(ticketId, ref)) : undefined;
        if (link !== undefined) links.set(ref.id, link);
      }
      const resolved =
        found.attachments.every((ref) => links.has(ref.id)) ||
        found.message === undefined ||
        channelType === undefined
          ? undefined
          : yield* gateway
              .resolveAttachments({ channelType, ...found.message })
              .pipe(Effect.result);
      const fresh =
        resolved?._tag === "Success"
          ? new Map(resolved.success.attachments.map((a) => [a.id, a.url]))
          : undefined;
      for (const { stored: _stored, ...ref } of found.attachments) {
        const url = links.get(ref.id) ?? fresh?.get(ref.id);
        out.push({
          eventId: event.id,
          ...ref,
          url: url ?? null,
          ...(url === undefined && {
            error:
              resolved?._tag === "Failure"
                ? `Could not read the message: ${resolved.failure.message}`
                : "The file is no longer on the message.",
          }),
        });
      }
    }
    return out;
  });

/** Largest file posted into a channel with a reply; Discord refuses bigger uploads. */
export const MAX_CHANNEL_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Starts a Worker's file upload: mints the attachment id and a signed PUT link bound to this
 * ticket, id and filename, so the Worker can write nothing else. `expiresInSeconds` is the
 * store's real link lifetime. The file is stored, and the ticket and its thread told, when the
 * PUT arrives (`completeAttachmentUpload`).
 */
export const requestAttachmentUpload = (input: {
  readonly ticketId: string;
  readonly filename: string;
  readonly contentType?: string;
}) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const store = yield* AssetStore;
    yield* tickets.get(input.ticketId);
    const attachmentId = yield* Effect.flatMap(IdGenerator, (g) => g.next);
    const key = assetKey(input.ticketId, { id: attachmentId, filename: input.filename });
    const link = yield* store.uploadLink(key);
    if (link === undefined) {
      return yield* new AssetStoreFailed({ message: "File storage is not configured." });
    }
    return {
      attachmentId,
      uploadUrl: link.url,
      contentType: input.contentType ?? "application/octet-stream",
      expiresInSeconds: link.expiresInSeconds,
    };
  });

/**
 * Serves a stored file to the holder of its signed download link. Fails with `AssetLinkInvalid`
 * when the signature is wrong or expired, `AssetNotFound` when nothing is stored under the key,
 * and `AssetStoreFailed` when storage can't be read.
 */
export const readAttachmentFile = (address: AttachmentAddress, link: LinkSignature) =>
  Effect.gen(function* () {
    const store = yield* AssetStore;
    const key = assetKey(address.ticketId, {
      id: address.attachmentId,
      filename: address.filename,
    });
    if (!Number.isFinite(link.expires) || !(yield* store.verify(key, link.expires, link.sig))) {
      return yield* new AssetLinkInvalid({ key });
    }
    const object: AssetObject | undefined = yield* store.get(key);
    if (object === undefined) return yield* new AssetNotFound({ key });
    return object;
  });

/**
 * Accepts a Worker's file PUT: checks the upload signature and the size limit, stores the file,
 * records it on the ticket as a worker comment (so listings and the dashboard show it), and posts
 * it to the ticket's thread. Fails with `AssetLinkInvalid`, `AttachmentTooLarge`, `TicketNotFound`
 * or `AssetStoreFailed`. Uploading the same attachment again replaces the bytes and records
 * nothing new. A thread that can't be reached, or a file too big for the channel, never fails
 * the upload: the thread gets a note instead.
 */
export const completeAttachmentUpload = (
  input: AttachmentAddress &
    LinkSignature & {
      readonly contentType: string;
      readonly size: number;
      readonly body: ReadableStream<Uint8Array>;
    },
  config: AttachmentStorageConfig = {},
) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const store = yield* AssetStore;
    const gateway = yield* ChannelGateway;
    const ref = { id: input.attachmentId, filename: input.filename };
    const key = assetKey(input.ticketId, ref);
    if (
      !Number.isFinite(input.expires) ||
      !(yield* store.verifyUpload(key, input.expires, input.sig))
    ) {
      return yield* new AssetLinkInvalid({ key });
    }
    const maxBytes = maxBytesOf(config);
    if (input.size > maxBytes) return yield* new AttachmentTooLarge({ size: input.size, maxBytes });
    yield* tickets.get(input.ticketId);
    yield* store.put({
      key,
      body: input.body,
      contentType: input.contentType,
      size: input.size,
      maxBytes,
    });
    const known = (yield* tickets.listEvents(input.ticketId)).some((event) =>
      readAttachmentsPayload(event.payload)?.attachments.some((a) => a.id === input.attachmentId),
    );
    if (known) return;
    yield* appendEvent({
      ticketId: input.ticketId,
      type: "comment",
      actor: "worker",
      body: `Attached ${input.filename}`,
      payload: {
        attachments: [{ ...ref, contentType: input.contentType, size: input.size, stored: true }],
      },
    });
    const destination = yield* ticketChannel(input.ticketId);
    if (!destination) return;
    const url = input.size <= MAX_CHANNEL_FILE_BYTES ? yield* store.link(key) : undefined;
    yield* gateway
      .send({
        ...destination,
        content:
          url === undefined
            ? `Attached ${input.filename}, too big to post here. It is on the ticket in the dashboard.`
            : `Attached ${input.filename}`,
        ...(url !== undefined && { files: [{ filename: input.filename, url }] }),
      })
      .pipe(Effect.ignoreCause);
  });

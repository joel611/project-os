import {
  AssetStore,
  assetKey,
  ChannelGateway,
  completeAttachmentUpload,
  MAX_CHANNEL_FILE_BYTES,
  requestAttachmentUpload,
  handleInbound,
  listTicketAttachments,
  readAttachmentFile,
  ProjectSourceRepository,
  ProjectRepository,
  TicketRepository,
} from "@project-os/core";
import type { InboundMessage } from "@project-os/contracts";
import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { classifierReturning, makeTestLayer, VALID_ASSET_SIG } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const file = (over: Partial<NonNullable<InboundMessage["attachments"]>[number]> = {}) => ({
  id: "a1",
  filename: "My Hero?.png",
  contentType: "image/png",
  size: 10,
  url: "https://cdn.discordapp.com/attachments/1/a1/hero.png?hm=x",
  ...over,
});
const message = (attachments: NonNullable<InboundMessage["attachments"]>): InboundMessage => ({
  channelType: "discord",
  externalId: "m1",
  channelId: "chan-1",
  sender: { id: "u1", name: "Pat" },
  content: "swap the hero",
  mentionsBot: true,
  attachments,
  raw: null,
  receivedAt: T0,
});

const setup = (options: Parameters<typeof makeTestLayer>[0] = {}) => {
  const test = makeTestLayer({ classifier: classifierReturning("new_request"), ...options });
  const runtime = ManagedRuntime.make(test.layer);
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    runtime.runPromise(effect as Effect.Effect<A, never, any>) as Promise<A>;
  const seed = Effect.gen(function* () {
    yield* (yield* ProjectRepository).insert({
      id: "p1",
      orgId: "o1",
      name: "Acme",
      slug: null,
      customInstructions: "",
      defaultResponseChannelId: null,
      status: "active",
      createdBy: null,
      createdAt: T0,
      updatedAt: T0,
    });
    yield* (yield* ProjectSourceRepository).insert({
      id: "s1",
      projectId: "p1",
      type: "discord_channel",
      externalId: "chan-1",
      name: "#general",
      alias: "chat",
      description: null,
      direction: "both",
      isDefaultResponse: true,
      config: {},
      status: "active",
      connectedBy: null,
      createdAt: T0,
      updatedAt: T0,
    });
  });
  const send = (msg: InboundMessage, config = {}) =>
    run(
      Effect.gen(function* () {
        yield* seed.pipe(Effect.ignore);
        return yield* handleInbound(msg, config);
      }),
    );
  return { test, run, send };
};

const eventsOf = (run: ReturnType<typeof setup>["run"], id: string) =>
  run(
    Effect.gen(function* () {
      return yield* (yield* TicketRepository).listEvents(id);
    }),
  );

const ticketOf = (outcome: Awaited<ReturnType<ReturnType<typeof setup>["send"]>>) =>
  (outcome as { ticket: { id: string } }).ticket.id;

describe("copying attachments at intake", () => {
  it("copies files from Discord's CDN under a safe key and marks them stored", async () => {
    const { test, run, send } = setup();
    const ticketId = ticketOf(await send(message([file()])));

    const key = assetKey(ticketId, file());
    expect(key).toBe(`${ticketId}/a1/My_Hero_.png`);
    expect([...test.storedAssets.keys()]).toEqual([key]);
    const events = await eventsOf(run, ticketId);
    expect((events[0]!.payload as any).attachments).toEqual([
      { id: "a1", filename: "My Hero?.png", contentType: "image/png", size: 10, stored: true },
    ]);
    const listed = await run(listTicketAttachments(ticketId));
    expect(listed).toEqual([
      expect.objectContaining({ id: "a1", url: `https://assets.test/${key}` }),
    ]);
  });

  it("names a file with nothing usable in its name just `file`", () => {
    expect(assetKey("t", { id: "a", filename: "???" })).toBe("t/a/file");
  });

  it("skips other hosts, malformed URLs and oversize files", async () => {
    const { test, send } = setup();
    await send(
      message([
        file({ id: "a1", url: "https://evil.example/x.png" }),
        file({ id: "a2", url: "not a url" }),
        file({ id: "a3", size: 101 }),
      ]),
      { attachments: { maxBytes: 100 } },
    );
    expect(test.storedAssets.size).toBe(0);
  });

  it("copies from a configured host", async () => {
    const { test, send } = setup();
    await send(message([file({ url: "http://localhost:9/f.png" })]), {
      attachments: { hosts: ["localhost"] },
    });
    expect(test.storedAssets.size).toBe(1);
  });

  it("does not copy files for a tool-only Sidekick request", async () => {
    const { test, send } = setup({ classifier: classifierReturning("new_request", 1, "sidekick") });
    const outcome = await send(message([file()]));
    expect(outcome.kind).toBe("ticket_created");
    expect(test.storedAssets.size).toBe(0);
  });

  it("keeps the ticket and the Discord link when the copy fails", async () => {
    const { test, send, run } = setup({ failAssetStore: "bucket down" });
    const outcome = await send(message([file()]));
    expect(outcome.kind).toBe("ticket_created");
    expect(test.storedAssets.size).toBe(0);
    const events = await eventsOf(run, ticketId(outcome));
    expect((events[0]!.payload as any).attachments[0]).not.toHaveProperty("stored");
  });
});

const ticketId = ticketOf;

describe("worker file uploads", () => {
  const body = (size = 3) => new Response(new Uint8Array(size)).body!;
  const upload = (
    ticket: string,
    attachmentId: string,
    size = 3,
    over: { sig?: string; config?: { maxBytes?: number } } = {},
  ) =>
    completeAttachmentUpload(
      {
        ticketId: ticket,
        attachmentId,
        filename: "r.txt",
        contentType: "text/plain",
        size,
        body: body(size),
        expires: 9_999_999_999,
        sig: over.sig ?? VALID_ASSET_SIG,
      },
      over.config,
    );

  it("mints a ticket-bound link, then stores, lists and posts the file once", async () => {
    const { test, run, send } = setup();
    const id = ticketId(await send(message([file()])));
    const sentBefore = test.sent.length;

    const minted = await run(requestAttachmentUpload({ ticketId: id, filename: "r.txt" }));
    expect(minted.uploadUrl).toBe(`https://assets.test/upload/${id}/${minted.attachmentId}/r.txt`);
    expect(minted.contentType).toBe("application/octet-stream");

    await run(upload(id, minted.attachmentId));
    await run(upload(id, minted.attachmentId));

    const listed = await run(listTicketAttachments(id));
    expect(listed.filter((f) => f.id === minted.attachmentId)).toHaveLength(1);
    const posts = test.sent.slice(sentBefore);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.files).toEqual([
      { filename: "r.txt", url: `https://assets.test/${id}/${minted.attachmentId}/r.txt` },
    ]);
  });

  it("posts a note instead of the file when it is too big for the channel", async () => {
    const { test, run, send } = setup();
    const id = ticketId(await send(message([file()])));
    await run(upload(id, "big", MAX_CHANNEL_FILE_BYTES + 1));
    const last = test.sent.at(-1)!;
    expect(last.files).toBeUndefined();
    expect(last.content).toContain("too big to post here");
  });

  it("still stores the file when the thread can't be reached", async () => {
    const { test, run, send } = setup();
    const id = ticketId(await send(message([file()])));
    await run(
      upload(id, "a9").pipe(
        Effect.provideService(ChannelGateway, {
          send: () => Effect.die("discord down"),
        } as unknown as typeof ChannelGateway.Service),
      ),
    );
    expect(test.storedAssets.has(`${id}/a9/r.txt`)).toBe(true);
  });

  it("records the file but posts nothing when the ticket has nowhere to reply", async () => {
    const { test, run, send } = setup();
    const id = ticketId(await send(message([file()])));
    const sentBefore = test.sent.length;
    await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        yield* upload(id, "a7").pipe(
          Effect.provideService(TicketRepository, {
            ...tickets,
            findThread: () => Effect.undefined,
          }),
          Effect.provideService(ProjectSourceRepository, {
            listByProject: () => Effect.succeed([]),
          } as unknown as typeof ProjectSourceRepository.Service),
        );
      }),
    );
    expect(test.sent.length).toBe(sentBefore);
    expect((await run(listTicketAttachments(id))).some((f) => f.id === "a7")).toBe(true);
  });

  it("fails to mint a link when file storage is not configured", async () => {
    const { run, send } = setup({ failAssetStore: "no storage" });
    const id = ticketId(await send(message([file()])));
    await expect(run(requestAttachmentUpload({ ticketId: id, filename: "r.txt" }))).rejects.toThrow(
      "File storage is not configured.",
    );
  });

  it("reports the store's real link lifetime, not a fixed hour", async () => {
    const { run, send } = setup();
    const id = ticketId(await send(message([file()])));
    const minted = await run(
      requestAttachmentUpload({ ticketId: id, filename: "r.txt" }).pipe(
        Effect.provideService(AssetStore, {
          uploadLink: () => Effect.succeed({ url: "https://assets.test/u", expiresInSeconds: 120 }),
        } as unknown as typeof AssetStore.Service),
      ),
    );
    expect(minted.expiresInSeconds).toBe(120);
  });

  it("refuses a bad signature before storing anything", async () => {
    const { test, run, send } = setup();
    const id = ticketId(await send(message([file()])));
    const stored = test.storedAssets.size;
    const error = await run(upload(id, "a1", 3, { sig: "forged" }).pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "AssetLinkInvalid" });
    expect(test.storedAssets.size).toBe(stored);
  });

  it("refuses a file over the configured size limit, for uploads as for intake", async () => {
    const { test, run, send } = setup();
    const id = ticketId(await send(message([file()])));
    const stored = test.storedAssets.size;
    const error = await run(upload(id, "a1", 11, { config: { maxBytes: 10 } }).pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "AttachmentTooLarge", size: 11, maxBytes: 10 });
    expect(test.storedAssets.size).toBe(stored);
    await run(upload(id, "a1", 10, { config: { maxBytes: 10 } }));
    expect(test.storedAssets.has(`${id}/a1/r.txt`)).toBe(true);
  });

  it("fails with TicketNotFound for a ticket that does not exist", async () => {
    const { test, run } = setup();
    const error = await run(upload("nope", "a1").pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "TicketNotFound" });
    expect(test.storedAssets.size).toBe(0);
  });
});

describe("downloading a stored file", () => {
  const sign = { expires: 9_999_999_999, sig: VALID_ASSET_SIG };
  const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

  it("serves what a Worker uploaded under the key the module derived from the link parts", async () => {
    const { run, send } = setup();
    const id = ticketId(await send(message([file()])));
    await run(
      completeAttachmentUpload({
        ticketId: id,
        attachmentId: "a2",
        filename: "My Report?.txt",
        contentType: "text/plain",
        size: 5,
        body: new Response("hello").body!,
        ...sign,
      }),
    );
    // The link carries the safe name; the key it is checked and read under is the same.
    const object = await run(
      readAttachmentFile({ ticketId: id, attachmentId: "a2", filename: "My_Report_.txt" }, sign),
    );
    expect(object).toMatchObject({ contentType: "text/plain", size: 5 });
    expect(await text(object.body)).toBe("hello");
  });

  it("refuses a bad or missing signature without reading storage", async () => {
    const { run } = setup();
    const address = { ticketId: "t", attachmentId: "a", filename: "f.txt" };
    for (const link of [
      { expires: 9_999_999_999, sig: "forged" },
      { expires: Number.NaN, sig: VALID_ASSET_SIG },
    ]) {
      const error = await run(readAttachmentFile(address, link).pipe(Effect.flip));
      expect(error).toMatchObject({ _tag: "AssetLinkInvalid" });
    }
  });

  it("fails with AssetNotFound when nothing is stored under a valid link", async () => {
    const { run } = setup();
    const error = await run(
      readAttachmentFile({ ticketId: "t", attachmentId: "a", filename: "f.txt" }, sign).pipe(
        Effect.flip,
      ),
    );
    expect(error).toMatchObject({ _tag: "AssetNotFound" });
  });
});

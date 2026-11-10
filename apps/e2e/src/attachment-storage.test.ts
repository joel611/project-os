import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// Files a PM attaches are copied out of Discord at intake, so a Worker can still fetch them after
// the message is deleted. The Worker gets a signed Coordinator link and downloads with a plain GET.

const CHANNEL = "chan-1";
const pm: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Pat" };
const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

let stack: Stack;
let mcp: Awaited<ReturnType<Stack["worker"]>>;
let projectId: string;

const start = async (options: { maxAttachmentBytes?: number } = {}) => {
  stack = await startStack({ classifier, ...options });
  const { secret } = await stack.registerSharedWorker();
  mcp = await stack.worker(secret);
  projectId = await stack.linkChannel(CHANNEL);
};
afterEach(() => stack.stop());

const attach = (url: string, over: Partial<{ id: string; size: number }> = {}) => ({
  id: over.id ?? "att-1",
  name: "hero image.png",
  contentType: "image/png",
  size: over.size ?? PNG.byteLength,
  url,
});
const say = async (attachment: ReturnType<typeof attach>, id = "msg-1") => {
  const inbound = fakeInbound(pm, "swap the hero image", { id, attachments: [attachment] });
  await forwardInbound(stack.coordinator, inbound!, fetch);
};
type Listed = Array<{ url: string | null; error?: string }>;
const allTickets = () =>
  stack.json("GET", `/projects/${projectId}/tickets`) as Promise<Array<{ id: string }>>;
const filesOf = async (ticketId: string): Promise<Listed> => {
  const res = (await mcp.callTool({
    name: "ticket_attachments",
    arguments: { ticketId },
  })) as unknown as { structuredContent: { attachments: Listed } };
  return res.structuredContent.attachments;
};
const listFiles = async () => filesOf((await allTickets())[0]!.id);

describe("attachment storage", () => {
  it("copies the file at intake and serves it by a signed link with a plain GET", async () => {
    await start();
    await say(attach(stack.hostFile("hero.png", PNG, "image/png")));

    const [file] = await listFiles();
    expect(file!.url).toMatch(
      new RegExp(`^${stack.url}/assets/[^/]+/att-1/hero_image.png\\?exp=\\d+&sig=[0-9a-f]{64}$`),
    );
    const res = await fetch(file!.url!);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("still serves the file after the Discord message is gone", async () => {
    await start();
    await say(attach(stack.hostFile("hero.png", PNG, "image/png")));
    // No entry in messageFiles: re-reading the message fails like a deleted one.

    const [file] = await listFiles();
    expect(file!.url).toContain("/assets/");
    expect((await fetch(file!.url!)).status).toBe(200);
  });

  it("refuses a tampered signature, a different file, and an expired link", async () => {
    await start();
    await say(attach(stack.hostFile("hero.png", PNG, "image/png")));
    const [file] = await listFiles();
    const url = new URL(file!.url!);

    const tampered = new URL(url);
    tampered.searchParams.set("sig", "0".repeat(64));
    expect((await fetch(tampered)).status).toBe(403);

    const other = new URL(url);
    other.pathname = other.pathname.replace("hero_image.png", "other.png");
    expect((await fetch(other)).status).toBe(403);

    const expired = new URL(url);
    expired.searchParams.set("exp", "1");
    expect((await fetch(expired)).status).toBe(403);

    const noExp = new URL(url);
    noExp.searchParams.delete("exp");
    expect((await fetch(noExp)).status).toBe(403);
  });

  it("leaves a file on its Discord link when the download fails", async () => {
    await start();
    // Nothing hosted at this path: the CDN answers 404.
    await say(attach(`http://localhost:${new URL(stack.hostFile("x", "x")).port}/files/missing`));
    stack.messageFiles.set(`${CHANNEL}/msg-1`, [
      {
        id: "att-1",
        filename: "hero image.png",
        contentType: "image/png",
        size: PNG.byteLength,
        url: "https://cdn.discordapp.com/fresh/hero.png",
      },
    ]);

    const [file] = await listFiles();
    expect(file!.url).toBe("https://cdn.discordapp.com/fresh/hero.png");
  });

  it("does not copy a file over the size limit, by the reported size or the real bytes", async () => {
    await start({ maxAttachmentBytes: 8 });
    // Reported over the limit: skipped without downloading.
    await say(attach(stack.hostFile("big.png", PNG), { size: 9 }), "msg-1");
    // Reported small, but the bytes are bigger: the stream is cut off and nothing is kept.
    await say(attach(stack.hostFile("liar.png", PNG), { id: "att-2", size: 4 }), "msg-2");

    const tickets = await allTickets();
    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) {
      expect((await filesOf(ticket.id)).every((file) => file.url === null)).toBe(true);
    }
  });
});

describe("attachments in the dashboard", () => {
  it("lists a ticket's files for the signed-in operator, with links an <img> can load", async () => {
    await start();
    await say(attach(stack.hostFile("hero.png", PNG, "image/png")));
    const [ticket] = await allTickets();

    const body = await stack.json("GET", `/tickets/${ticket!.id}/attachments`);

    expect(body.attachments).toEqual([
      expect.objectContaining({
        id: "att-1",
        filename: "hero image.png",
        contentType: "image/png",
        url: expect.stringContaining("/assets/"),
      }),
    ]);
    // An <img> sends no Authorization header: the signed link alone must load, and show inline.
    const image = await fetch(body.attachments[0].url);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-disposition")).toContain("inline");
  });

  it("needs a dashboard session, and 404s for an unknown ticket", async () => {
    await start();
    await say(attach(stack.hostFile("hero.png", PNG, "image/png")));
    const [ticket] = await allTickets();

    expect((await fetch(`${stack.url}/tickets/${ticket!.id}/attachments`)).status).toBe(401);
    const missing = await fetch(`${stack.url}/tickets/nope/attachments`, {
      headers: { authorization: `Bearer ${stack.operatorToken}` },
    });
    expect(missing.status).toBe(404);
  });
});

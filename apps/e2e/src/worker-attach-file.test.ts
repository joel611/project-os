import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// A Worker sends a file it made back on its ticket: `ticket_attach_file` returns a signed PUT
// link, the Worker uploads with a plain PUT, and the Coordinator stores it, lists it on the
// ticket, and posts it to the ticket's Discord thread.

const CHANNEL = "chan-1";
const pm: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Pat" };
const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});
const REPORT = new TextEncoder().encode("quarterly numbers");

let stack: Stack;
let mcp: Awaited<ReturnType<Stack["worker"]>>;
let ticketId: string;

const call = async <T>(name: string, args: Record<string, unknown>) =>
  ((await mcp.callTool({ name, arguments: args })) as unknown as { structuredContent: T })
    .structuredContent;

const start = async () => {
  stack = await startStack({ classifier });
  const { secret } = await stack.registerSharedWorker();
  mcp = await stack.worker(secret);
  const projectId = await stack.linkChannel(CHANNEL);
  await forwardInbound(
    stack.coordinator,
    fakeInbound(pm, "make the report", { id: "msg-1" })!,
    fetch,
  );
  const tickets = (await stack.json("GET", `/projects/${projectId}/tickets`)) as Array<{
    id: string;
  }>;
  ticketId = tickets[0]!.id;
};
const requestUpload = (filename = "report.txt", contentType = "text/plain") =>
  call<{ attachmentId: string; uploadUrl: string }>("ticket_attach_file", {
    ticketId,
    filename,
    contentType,
  });
const put = (url: string | URL, body: Uint8Array, type = "text/plain") =>
  fetch(url, { method: "PUT", headers: { "content-type": type }, body });
const listed = () =>
  call<{ attachments: Array<{ id: string; filename: string; url: string | null }> }>(
    "ticket_attachments",
    { ticketId },
  ).then((r) => r.attachments);

afterEach(() => stack.stop());

describe("worker attach file", () => {
  it("stores the upload, lists it on the ticket, and posts it to the thread", async () => {
    await start();
    const before = stack.posted.length;
    const { attachmentId, uploadUrl } = await requestUpload();

    const res = await put(uploadUrl, REPORT);
    expect(res.status).toBe(200);

    const [file] = await listed();
    expect(file).toMatchObject({ id: attachmentId, filename: "report.txt" });
    const download = await fetch(file!.url!);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(REPORT);

    const posts = stack.posted.slice(before).filter((p) => p.files);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.files![0]!.filename).toBe("report.txt");
    expect(posts[0]!.files![0]!.data).toEqual(REPORT);
  });

  it("records and posts once when the same upload is repeated", async () => {
    await start();
    const { uploadUrl } = await requestUpload();
    await put(uploadUrl, REPORT);
    await put(uploadUrl, REPORT);

    expect(await listed()).toHaveLength(1);
    expect(stack.posted.filter((p) => p.files)).toHaveLength(1);
  });

  it("refuses a tampered link, another file name, and a download link used to upload", async () => {
    await start();
    const { uploadUrl } = await requestUpload();
    const url = new URL(uploadUrl);

    const tampered = new URL(url);
    tampered.searchParams.set("sig", "0".repeat(64));
    expect((await put(tampered, REPORT)).status).toBe(403);

    const other = new URL(url);
    other.pathname = other.pathname.replace("report.txt", "other.txt");
    expect((await put(other, REPORT)).status).toBe(403);

    await put(url, REPORT);
    const [file] = await listed();
    expect((await put(file!.url!, new TextEncoder().encode("overwritten"))).status).toBe(403);
    const download = await fetch(file!.url!);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(REPORT);
  });

  it("keeps a file too big for Discord on the ticket and says so in the thread", async () => {
    await start();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const { uploadUrl } = await requestUpload("big.bin", "application/octet-stream");
    expect((await put(uploadUrl, big, "application/octet-stream")).status).toBe(200);

    expect(await listed()).toHaveLength(1);
    expect(stack.posted.some((p) => p.files)).toBe(false);
    expect(stack.posted.at(-1)!.content).toContain("too big to post here");
  });

  it("refuses a ticket the Worker does not hold", async () => {
    await start();
    const res = (await mcp.callTool({
      name: "ticket_attach_file",
      arguments: { ticketId: "someone-elses", filename: "x.txt" },
    })) as unknown as { isError?: boolean };
    expect(res.isError).toBe(true);
  });
});

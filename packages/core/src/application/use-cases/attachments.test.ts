import { describe, expect, it } from "vite-plus/test";
import { attachmentsPayload, readAttachmentsPayload } from "./attachments.ts";

const ref = { id: "a1", filename: "x.png", contentType: "image/png", size: 1 };
const message = { channelId: "c1", messageId: "m1" };
const bare = {
  channelType: "discord" as const,
  externalId: "m1",
  channelId: "c1",
  sender: { id: "u" },
  content: "hi",
  raw: null,
  receivedAt: "t",
};

describe("attachments payload", () => {
  it("reads back what it wrote, pointing at the thread when the message was in one", () => {
    const written = attachmentsPayload({
      ...bare,
      channelId: "c0",
      threadId: "c1",
      attachments: [{ ...ref, url: "https://cdn/x.png?hm=1" }],
    });
    expect(readAttachmentsPayload(written)).toEqual({ attachments: [ref], message });
    expect(JSON.stringify(written)).not.toContain("cdn");
  });

  it("writes nothing for a message without files", () => {
    expect(attachmentsPayload(bare)).toEqual({});
    expect(attachmentsPayload({ ...bare, attachments: [] })).toEqual({});
  });

  it.each([
    ["no payload", null],
    ["a non-object payload", "text"],
    ["no attachments", { message }],
    ["empty attachments", { attachments: [], message }],
    ["no message", { attachments: [ref] }],
    ["a null message", { attachments: [ref], message: null }],
    ["a message without ids", { attachments: [ref], message: { channelId: 1 } }],
  ])("reads undefined from %s", (_name, payload) => {
    expect(readAttachmentsPayload(payload)).toBeUndefined();
  });
});

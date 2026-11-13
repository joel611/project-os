import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// The dashboard's Channel tab answers "did Discord deliver this message?": every message in a
// linked project channel is recorded as received, mentioned or not, with mentions removed.

const ada: FakeSpeaker = { channelId: "chan-1", userId: "u1", name: "Ada", guildId: "guild-1" };

const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

let stack: Stack;
afterEach(() => stack.stop());

describe("inbound log", () => {
  it("lists every message a project channel received, newest first, without mentions", async () => {
    stack = await startStack({ classifier });
    const projectId = await stack.linkChannel("chan-1");
    const send = async (content: string, options: { id: string; mention: boolean; at: Date }) =>
      forwardInbound(stack.coordinator, fakeInbound(ada, content, options)!, fetch);

    await send("just chatting <@999>", { id: "m1", mention: false, at: new Date(1_000_000) });
    await send("please add dark mode", { id: "m2", mention: true, at: new Date(2_000_000) });
    await forwardInbound(
      stack.coordinator,
      fakeInbound({ ...ada, channelId: "unlinked" }, "elsewhere", { id: "m3", mention: false })!,
      fetch,
    );

    const log = (await stack.json("GET", `/projects/${projectId}/inbound`)) as Array<{
      externalId: string;
      content: string;
      mentionsBot: boolean;
      senderName: string;
    }>;
    expect(log.map((e) => [e.externalId, e.content, e.mentionsBot, e.senderName])).toEqual([
      ["m2", "please add dark mode", true, "Ada"],
      ["m1", "just chatting", false, "Ada"],
    ]);
  });
});

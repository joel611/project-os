import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { SERVICE_TOKEN, type Stack, startStack } from "./stack.ts";

// An error the Coordinator does not handle is written to the audit log (kind `runtime_error`,
// secrets masked, one row per error per hour), and the dashboard's "Export incident report"
// turns the log into a Markdown file to post in the project's channel.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada", guildId: "guild-1" };
const LEAKED = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

/** A decision model that crashes (a defect, not a typed failure the Coordinator handles). */
const crashingClassifier = Layer.succeed(IntentClassifier, {
  classify: () =>
    Effect.die(new Error(`model crashed for request 42 with ${LEAKED} and ${SERVICE_TOKEN}`)),
  classifyMessage: () => Effect.die(new Error("unused")),
} as never);

interface Entry {
  kind: string;
  action: string;
  actorType: string;
  summary: string;
  payload: any;
}

let stack: Stack;
afterEach(() => stack.stop());

const send = (id: string) =>
  forwardInbound(
    stack.coordinator,
    fakeInbound(ada, "please add dark mode", { id, mention: true })!,
    fetch,
  ).catch(() => undefined);

const rows = async (): Promise<Entry[]> =>
  (await stack.json("GET", "/audit?kind=runtime_error")).entries;

const waitForRows = async (count: number) => {
  for (let i = 0; i < 50; i++) {
    const found = await rows();
    if (found.length >= count) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return rows();
};

describe("runtime errors", () => {
  it("logs an unhandled route error once an hour, masked, and exports it in the incident report", async () => {
    stack = await startStack({ classifier: crashingClassifier });
    await stack.linkChannel(CHANNEL);

    await send("m1");
    await send("m2");
    const [entry, ...rest] = await waitForRows(1);

    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      kind: "runtime_error",
      action: "raised",
      actorType: "coordinator",
      payload: { source: "http", where: "POST /inbound" },
    });
    const logged = JSON.stringify(entry);
    expect(logged).not.toContain(LEAKED);
    expect(logged).not.toContain(SERVICE_TOKEN);
    expect(logged).toContain("model crashed");

    const res = await fetch(`${stack.url}/audit/report?hours=24`, {
      headers: { authorization: `Bearer ${stack.operatorToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="incident-report-\d{8}-\d{4}\.md"/,
    );
    const report = await res.text();
    expect(report).toContain("# Incident report");
    expect(report).toContain("1 distinct error(s)");
    expect(report).toContain("POST /inbound");
    expect(report).toContain("model crashed");
    expect(report).not.toContain(LEAKED);
    expect(report).not.toContain(SERVICE_TOKEN);
  });

  it("does not log a bad request, and the report needs a signed-in admin and a valid window", async () => {
    stack = await startStack({ classifier: crashingClassifier });

    const bad = await fetch(`${stack.url}/no/such/route`, {
      headers: { authorization: `Bearer ${stack.operatorToken}` },
    });
    expect(bad.status).toBe(404);
    expect(await rows()).toEqual([]);

    expect((await fetch(`${stack.url}/audit/report`)).status).toBe(401);
    const badHours = await fetch(`${stack.url}/audit/report?hours=abc`, {
      headers: { authorization: `Bearer ${stack.operatorToken}` },
    });
    expect(badHours.status).toBe(400);
    const missing = await fetch(`${stack.url}/audit/report?projectId=nope`, {
      headers: { authorization: `Bearer ${stack.operatorToken}` },
    });
    expect(missing.status).toBe(404);

    const empty = await (
      await fetch(`${stack.url}/audit/report`, {
        headers: { authorization: `Bearer ${stack.operatorToken}` },
      })
    ).text();
    expect(empty).toContain("0 distinct error(s)");
    expect(empty).toContain("None in this window.");
  });
});

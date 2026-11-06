import { Database } from "bun:sqlite";
import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// /connect in Discord -> Coordinator /commands -> one-time link -> browser: /connect/:token
// -> fake provider authorize -> Better Auth callback (real, on the Coordinator) -> /connect/done.
// Then a Worker asks `user_token` for the ticket and gets that person's token, refreshed by
// Better Auth when it is about to expire. Google and GitHub are one fake OAuth server.

const WORKER = "w1";
const CHANNEL = "chan-1";
const ada = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };
const bob = { channelId: CHANNEL, userId: "u-bob", name: "Bob" };

let stack: Stack;
beforeEach(async () => {
  stack = await startStack({
    classifier: classifierReturning("new_request"),
    workerId: WORKER,
    connections: true,
  });
  await stack.linkChannel(CHANNEL);
});
afterEach(() => stack.stop());

const slash = (speaker: typeof ada, name: string, options: Record<string, string> = {}) =>
  forwardCommand(stack.url, fakeCommand(speaker, name, options)!, fetch);

const connect = async (speaker: typeof ada, provider: string) => {
  const reply = await slash(speaker, "connect", { provider });
  expect(reply.ephemeral).toBe(true);
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)?.[1];
  expect(link, reply.content).toBeDefined();
  return { link: link!, page: await browse(link!) };
};

const say = async (speaker: typeof ada, content: string) => {
  await forwardInbound(stack.url, fakeInbound(speaker, content)!, fetch);
  const [project] = await stack.json("GET", "/projects");
  const tickets = await stack.json("GET", `/projects/${project.id}/tickets`);
  return tickets[0].id as string;
};

const userToken = async (ticketId: string, provider: string) => {
  const mcp = await stack.worker();
  return (await mcp.callTool({ name: "user_token", arguments: { ticketId, provider } })) as {
    isError?: boolean;
    structuredContent?: any;
    content: { text: string }[];
  };
};

describe("per-person account linking", () => {
  it("links Google from Discord and hands the Worker that person's token", async () => {
    const { page } = await connect(ada, "google");
    expect(page, JSON.stringify(page)).toMatchObject({ status: 200 });
    expect(page.url).toContain("/connect/done?provider=google");
    expect(page.body).toContain("Google account connected");

    expect((await slash(ada, "connections")).content).toContain("Linked: Google");

    const ticketId = await say(ada, "summarize the Q3 planning doc");
    const res = await userToken(ticketId, "google");
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      accessToken: "at-google-1",
      person: { channelType: "discord", id: "u-ada", name: "Ada" },
    });
    // Tokens are encrypted at rest: the raw tokens never appear in the database.
    const db = new Database(stack.dbPath, { readonly: true });
    const row = db.query("select access_token, refresh_token from auth_accounts").get() as any;
    db.close();
    expect(row.access_token).not.toContain("at-google-1");
    expect(row.refresh_token).not.toContain("rt-google-1");
    expect(stack.oauth!.tokenRequests).toEqual([
      { provider: "google", grantType: "authorization_code" },
    ]);
  });

  it("refreshes an expiring token before handing it out", async () => {
    stack.oauth!.expiresIn = 1; // under Better Auth's 5 s margin: stale at once
    await connect(ada, "github");
    const ticketId = await say(ada, "triage the open issues");
    const res = await userToken(ticketId, "github");
    expect(res.structuredContent.accessToken).toBe("at-github-2");
    expect(stack.oauth!.tokenRequests.map((r) => r.grantType)).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  it("gives up and asks to reconnect when the refresh token is refused", async () => {
    stack.oauth!.expiresIn = 1;
    stack.oauth!.failRefresh = true;
    await connect(ada, "google");
    const ticketId = await say(ada, "summarize the Q3 planning doc");
    const res = await userToken(ticketId, "google");
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text, res.content[0]!.text).toContain("expired or was revoked");
  });

  it("hands out a token that never expires with no expiry", async () => {
    stack.oauth!.expiresIn = 0;
    await connect(ada, "github");
    const ticketId = await say(ada, "triage the open issues");
    expect((await userToken(ticketId, "github")).structuredContent).toMatchObject({
      accessToken: "at-github-1",
      expiresAt: null,
    });
  });

  it("shows an error page when the provider won't say who the account is", async () => {
    stack.oauth!.failUserInfo = true;
    const { page } = await connect(ada, "github");
    expect(page.status).toBe(400);
    expect(page.body).toContain("Linking your GitHub account failed");
    expect((await slash(ada, "connections")).content).toContain("haven't linked");
  });

  it("serves a generic done page", async () => {
    const res = await fetch(`${stack.url}/connect/done`);
    expect(await res.text()).toContain("Your account connected");
  });

  it("a connect link works once", async () => {
    const { link } = await connect(ada, "google");
    const again = await browse(link);
    expect(again.status).toBe(410);
  });

  it("asks an unlinked requester to /connect in the channel and fails NotConnected", async () => {
    await connect(ada, "google");
    const ticketId = await say(bob, "summarize the Q3 planning doc");
    const res = await userToken(ticketId, "google");
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("NotConnected");
    expect(stack.posted.map((p) => p.content)).toContainEqual(
      expect.stringContaining("<@u-bob>, I need your Google access"),
    );
  });

  it("/disconnect removes the link", async () => {
    await connect(ada, "google");
    expect((await slash(ada, "disconnect", { provider: "google" })).content).toBe(
      "Disconnected Google.",
    );
    const ticketId = await say(ada, "summarize the Q3 planning doc");
    expect((await userToken(ticketId, "google")).isError).toBe(true);
  });
});

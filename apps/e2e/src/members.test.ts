import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// The Members page joins three identities per person: the dashboard's Google sign-in, the Discord
// user that linked the same Google account with /connect google, and the GitHub account linked
// from Discord (which may use any email). GET /members is Operators' only.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };
const bob: FakeSpeaker = { channelId: CHANNEL, userId: "u-bob", name: "Bob" };

const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

let stack: Stack;
const start = async (allowedEmails: string[] = []) => {
  stack = await startStack({ classifier, connections: true, allowedEmails });
  await stack.linkChannel(CHANNEL);
};
afterEach(() => stack.stop());

const slash = (who: FakeSpeaker, name: string, options: Record<string, string> = {}) =>
  forwardCommand(stack.coordinator, fakeCommand(who, name, options)!, fetch);

const connect = async (who: FakeSpeaker, provider: "google" | "github") => {
  const reply = await slash(who, "connect", { provider });
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)?.[1];
  expect(link, reply.content).toBeDefined();
  await browse(link!, undefined, "POST");
};

const signIn = async () => {
  const landed = new URL((await browse(`${stack.url}/sign-in/google`)).url);
  const ott = landed.searchParams.get("ott")!;
  const verified = await fetch(`${stack.url}/api/auth/one-time-token/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ott }),
  });
  return verified.headers.get("set-auth-token")!;
};

const members = async (token: string) => {
  const res = await fetch(`${stack.url}/members`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe("members", () => {
  it("joins the dashboard sign-in, the Discord user and GitHub through the Google account", async () => {
    await start(["ada@example.com"]);
    // Ada signs in to the dashboard, then links Google and GitHub from Discord.
    const token = await signIn();
    await connect(ada, "google");
    await connect(ada, "github");

    const { status, body } = await members(token);
    expect(status).toBe(200);
    // Ada is one row, not two; the other is the password operator (ADMIN_EMAIL).
    expect(body).toHaveLength(2);
    const row = body.find((m: { email: string }) => m.email === "ada@example.com");
    expect(row).toMatchObject({
      email: "ada@example.com",
      admin: true,
      googleLinked: true,
      channel: { type: "discord", id: "u-ada", name: "Ada" },
      github: { login: "ada-gh" },
    });
    expect(row.dashboard.lastSignInAt).toEqual(expect.any(String));
  });

  it("keeps people apart and shows what is missing", async () => {
    await start(["ada@example.com"]);
    const token = await signIn();
    // Bob links GitHub only, with a different Google account never used on the dashboard.
    stack.oauth!.sub = "google-bob";
    stack.oauth!.email = "bob@example.com";
    await connect(bob, "google");
    await connect(bob, "github");

    const { body } = await members(token);
    const by = (name: string) => body.find((m: { name: string }) => m.name === name);
    // Ada: dashboard only, no Discord or GitHub.
    expect(by("Ada Lovelace")).toMatchObject({ admin: true, channel: null, github: null });
    // Bob: a Discord member who never opened the dashboard.
    expect(by("Bob")).toMatchObject({
      admin: false,
      dashboard: null,
      email: "bob@example.com",
      channel: { id: "u-bob" },
      github: { login: "ada-gh" },
    });
    // Plus the password operator, who never linked anything.
    expect(body).toHaveLength(3);
  });

  it("is Operators' only", async () => {
    await start();
    await connect(ada, "google");
    const memberToken = await signIn(); // no operator list: Ada signs in as a member
    expect((await members(memberToken)).status).toBe(403);
    expect((await fetch(`${stack.url}/members`)).status).toBe(401);
    expect((await members(stack.operatorToken)).status).toBe(200);
  });
});

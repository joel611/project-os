import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import {
  fakeCommand,
  fakeInbound,
  type FakeSpeaker,
} from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// A Discord member sees their own tickets on the dashboard: /dashboard in Discord -> the Google
// connect link (the same one-time /connect flow) -> Google sign-in on the dashboard, which finds
// the Discord identity that linked this Google account and signs in as it -> /me/tickets lists the
// tickets they asked for or wrote in, and nothing else of the dashboard API is theirs.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };
const bob: FakeSpeaker = { channelId: CHANNEL, userId: "u-bob", name: "Bob" };

const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

let stack: Stack;
const start = async (
  options: Parameters<typeof startStack>[0] extends infer O ? Partial<O> : never,
) => {
  stack = await startStack({ classifier, connections: true, ...options });
  await stack.registerSharedWorker();
  await stack.linkChannel(CHANNEL);
};
afterEach(() => stack.stop());

const say = async (who: FakeSpeaker, content: string) => {
  const inbound = fakeInbound(who, content);
  if (!inbound) throw new Error("message was dropped");
  await forwardInbound(stack.coordinator, inbound, fetch);
};

const slash = (who: FakeSpeaker, name: string, options: Record<string, string> = {}) =>
  forwardCommand(stack.coordinator, fakeCommand(who, name, options)!, fetch);

/** Follows the link in a reply the way a person would: open it, press Continue. */
const followConnectLink = async (content: string) => {
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(content)?.[1];
  expect(link, content).toBeDefined();
  const page = await browse(link!, undefined, "POST");
  expect(page.body).toContain("Google account connected");
};

/** Dashboard Google sign-in, through to the Bearer token; undefined when it was refused. */
const signIn = async () => {
  const landed = new URL((await browse(`${stack.url}/sign-in/google`)).url);
  const ott = landed.searchParams.get("ott");
  if (!ott) return undefined;
  const verified = await fetch(`${stack.url}/api/auth/one-time-token/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ott }),
  });
  return verified.headers.get("set-auth-token") ?? undefined;
};

const get = async (token: string, path: string) => {
  const res = await fetch(`${stack.url}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** Ada asks for one ticket and writes in Bob's thread; Bob has one more of his own. */
const seedTickets = async () => {
  await say(ada, "please add dark mode");
  await say(bob, "fix the login bug");
  await say({ ...ada, threadId: "discord-thread-2" }, "it happens on Safari too");
  await say(bob, "rename the repo");
  const all = (await stack.json(
    "GET",
    `/projects/${(await stack.json("GET", "/projects"))[0].id}/tickets`,
  )) as Array<{ id: string; title: string }>;
  const id = (title: string) => all.find((t) => t.title === title)!.id;
  return {
    asked: id("please add dark mode"),
    joined: id("fix the login bug"),
    bobs: id("rename the repo"),
  };
};

describe("member dashboard", () => {
  beforeEach(() => start({}));

  it("links Google from /dashboard and signs the member in to their own tickets only", async () => {
    const { asked, joined, bobs } = await seedTickets();

    const first = await slash(ada, "dashboard");
    expect(first.ephemeral).toBe(true);
    expect(first.content).toContain(`${stack.webUrl}/login`);
    await followConnectLink(first.content);
    // Once linked, /dashboard just points at the dashboard.
    expect((await slash(ada, "dashboard")).content).not.toContain("/connect/");

    const token = await signIn();
    expect(token).toBeTruthy();

    expect(await get(token!, "/me")).toEqual({
      status: 200,
      body: {
        role: "member",
        name: "Ada",
        person: { channelType: "discord", id: "u-ada", name: "Ada" },
      },
    });

    const mine = await get(token!, "/me/tickets");
    expect(mine.status).toBe(200);
    expect(mine.body.tickets.map((t: { id: string }) => t.id).sort()).toEqual(
      [asked, joined].sort(),
    );
    expect(mine.body.projects).toHaveLength(1);

    expect((await get(token!, `/tickets/${joined}`)).status).toBe(200);
    expect((await get(token!, `/tickets/${asked}/attachments`)).status).toBe(200);
    // Bob's own ticket is as invisible as a missing one.
    expect(await get(token!, `/tickets/${bobs}`)).toMatchObject({
      status: 404,
      body: { error: "TicketNotFound" },
    });
    expect((await get(token!, `/tickets/${bobs}/attachments`)).status).toBe(404);

    // Signing in again finds the same member.
    expect((await get((await signIn())!, "/me")).body.person.id).toBe("u-ada");

    // The rest of the dashboard stays Operators'.
    for (const path of ["/projects", "/workers", "/activity"]) {
      expect((await get(token!, path)).status, path).toBe(403);
    }
  });

  it("refuses a Google sign-in that no Discord member linked", async () => {
    await slash(ada, "connections");
    expect(await signIn()).toBeUndefined();
  });

  it("ends dashboard access when the member unlinks Google", async () => {
    await followConnectLink((await slash(ada, "dashboard")).content);
    const token = (await signIn())!;
    expect((await get(token, "/me")).status).toBe(200);

    expect((await slash(ada, "disconnect", { provider: "google" })).content).toBe(
      "Disconnected Google.",
    );
    expect((await get(token, "/me")).status).toBe(403);
    expect(await signIn()).toBeUndefined();
  });

  it("keeps each member to their own Google account", async () => {
    await followConnectLink((await slash(ada, "dashboard")).content);
    stack.oauth!.sub = "google-bob";
    stack.oauth!.email = "bob@example.com";
    await followConnectLink((await slash(bob, "dashboard")).content);

    const bobs = (await signIn())!;
    expect((await get(bobs, "/me")).body.person.id).toBe("u-bob");
    stack.oauth!.sub = "google-ada";
    stack.oauth!.email = "ada@example.com";
    const adas = (await signIn())!;
    expect((await get(adas, "/me")).body.person.id).toBe("u-ada");
  });
});

describe("member dashboard with GOOGLE_ALLOWED_DOMAINS", () => {
  it("lets a linked member outside the domains in, as a member", async () => {
    await start({ allowedDomains: ["acme.com"] });
    await followConnectLink((await slash(ada, "dashboard")).content);
    const token = await signIn();
    expect(token).toBeTruthy();
    expect((await get(token!, "/me")).body.role).toBe("member");
    expect((await get(token!, "/projects")).status).toBe(403);
  });
});

describe("operator with a linked Discord identity", () => {
  it("keeps the full dashboard and also gets My tickets", async () => {
    await start({ allowedEmails: ["ada@example.com"] });
    const { asked, joined } = await seedTickets();
    await followConnectLink((await slash(ada, "connect", { provider: "google" })).content);

    const token = (await signIn())!;
    expect(await get(token, "/me")).toEqual({
      status: 200,
      body: {
        role: "operator",
        name: "Ada Lovelace",
        person: { channelType: "discord", id: "u-ada", name: "Ada" },
      },
    });
    expect((await get(token, "/projects")).status).toBe(200);
    const mine = await get(token, "/me/tickets");
    expect(mine.body.tickets.map((t: { id: string }) => t.id).sort()).toEqual(
      [asked, joined].sort(),
    );
  });

  it("finds no person behind the password operator", async () => {
    await start({});
    expect((await get(stack.operatorToken, "/me")).body).toMatchObject({
      role: "operator",
      person: null,
    });
  });

  it("has no tickets of their own without a linked identity", async () => {
    await start({ allowedEmails: ["ada@example.com"] });
    const token = (await signIn())!;
    expect((await get(token, "/me")).body).toMatchObject({ role: "operator", person: null });
    expect((await get(token, "/me/tickets")).body).toEqual({ tickets: [], projects: [] });
  });
});

import { EMAIL_DIGEST_AUTHOR, IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// Email Digest: a member links Google (with Gmail read access) from /dashboard, switches their
// mailbox on in the dashboard, and the Coordinator reads their inbox through Gmail's API (a fake
// one on localhost). Each email is redacted, matched to a project by the classifier, and filed
// into Project Memory when it is sure (90%); otherwise it waits in the dashboard for the person.
// Filing one by hand teaches the classifier: the next email from that sender goes there.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };

const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

let stack: Stack;
afterEach(() => stack.stop());

const slash = (who: FakeSpeaker, name: string) =>
  forwardCommand(stack.coordinator, fakeCommand(who, name, {})!, fetch);

/** /dashboard -> connect Google -> dashboard sign-in; the member's Bearer token. */
const signInAsAda = async () => {
  const reply = await slash(ada, "dashboard");
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)![1]!;
  expect((await browse(link, undefined, "POST")).body).toContain("Google account connected");
  const landed = new URL((await browse(`${stack.url}/sign-in/google`)).url);
  const verified = await fetch(`${stack.url}/api/auth/one-time-token/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: landed.searchParams.get("ott") }),
  });
  return verified.headers.get("set-auth-token")!;
};

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${stack.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

const memory = (projectId: string) =>
  stack.json("GET", `/projects/${projectId}/memory`) as Promise<
    Array<{ type: string; title: string; createdBy: string; sourceMetadata: any }>
  >;

const start = async (options: { confidence?: number } = {}) => {
  stack = await startStack({ classifier, connections: true, email: options });
  const acme = await stack.linkChannel(CHANNEL);
  const globex = (await stack.json("POST", "/projects", { orgId: "o1", name: "Globex" }))
    .id as string;
  return { acme, globex };
};

describe("email digest", () => {
  it("files a sure match into memory, redacted, and holds the rest until the member picks", async () => {
    const { acme, globex } = await start();
    const token = await signInAsAda();
    const email = stack.email!;

    // Switched off until the member says so.
    const before = await call(token, "GET", "/me/email");
    expect(before.body).toMatchObject({ available: true, enabled: false, unassigned: [] });
    expect(before.body.projects.map((p: { name: string }) => p.name).sort()).toEqual([
      "Acme",
      "Globex",
    ]);
    await email.runDigest();
    expect(email.gmailCalls).toEqual([]);

    const on = await call(token, "POST", "/me/email/enabled", { enabled: true });
    expect(on.body).toMatchObject({ enabled: true, needsReconnect: false });

    // The first run only notes where the mailbox is: mail from before it was switched on is not read.
    email.deliver({
      id: "old",
      from: "x@y.test",
      subject: "Before",
      body: "Acme was decided long ago",
    });
    await email.runDigest();
    expect(email.gmailCalls.every((c) => c.includes("Bearer at-google-"))).toBe(true);
    expect(await memory(acme)).toEqual([]);

    // A sure match is filed; a promotion is never read; an unsure one waits.
    email.deliver(
      {
        id: "m1",
        from: "Dana Lee <dana@acme.test>",
        subject: "Acme launch date",
        body: "We decided the Acme launch is 1 December. Pay with card 4242 4242 4242 4242, password: hunter2.",
      },
      {
        id: "m2",
        from: "deals@shop.test",
        subject: "Acme sale!",
        body: "decided",
        labels: ["INBOX", "CATEGORY_PROMOTIONS"],
      },
      {
        id: "m3",
        from: "Vendor <vendor@x.test>",
        subject: "Hello",
        body: "We decided to change the price.",
      },
    );
    await email.runDigest();

    const filed = await memory(acme);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ type: "decision", createdBy: EMAIL_DIGEST_AUTHOR });
    expect(filed[0]!.sourceMetadata).toMatchObject({
      source: "email_digest",
      from: "Dana Lee <dana@acme.test>",
      subject: "Acme launch date",
      assignedBy: "classifier",
    });
    // Nothing secret reached memory or the model.
    const everything = JSON.stringify([filed, email.classifyCalls, stack.digestCalls]);
    expect(everything).not.toMatch(/4242|hunter2/);
    expect(everything).toContain("[redacted card]");

    const waiting = await call(token, "GET", "/me/email");
    expect(waiting.body.unassigned).toHaveLength(1);
    expect(waiting.body.unassigned[0]).toMatchObject({
      fromAddress: "vendor@x.test",
      subject: "Hello",
    });
    expect(await memory(globex)).toEqual([]);

    // The member files it under Globex, by hand.
    const emailId = waiting.body.unassigned[0].id as string;
    expect(
      (await call(token, "POST", `/me/email/${emailId}/assign`, { projectId: globex })).body,
    ).toEqual({
      saved: 1,
    });
    expect((await memory(globex))[0]!.sourceMetadata).toMatchObject({ assignedBy: "person" });
    expect((await call(token, "GET", "/me/email")).body.unassigned).toEqual([]);
    // Filing twice, or filing someone else's, is a 404.
    expect(
      (await call(token, "POST", `/me/email/${emailId}/assign`, { projectId: globex })).status,
    ).toBe(404);

    // It learned: the next email from that sender goes to Globex on its own.
    email.deliver({
      id: "m4",
      from: "Vendor <vendor@x.test>",
      subject: "Invoice",
      body: "We decided on net 30.",
    });
    await email.runDigest();
    const learned = await memory(globex);
    expect(learned).toHaveLength(2);
    expect(learned.map((m) => m.sourceMetadata.assignedBy).sort()).toEqual([
      "classifier",
      "person",
    ]);
  });

  it("holds a match below 90% for the member, with the suggestion", async () => {
    const { acme } = await start({ confidence: 0.7 });
    const token = await signInAsAda();
    await call(token, "POST", "/me/email/enabled", { enabled: true });
    await stack.email!.runDigest();
    stack.email!.deliver({
      id: "m1",
      from: "dana@acme.test",
      subject: "Acme",
      body: "We decided to ship.",
    });
    await stack.email!.runDigest();

    expect(await memory(acme)).toEqual([]);
    const waiting = (await call(token, "GET", "/me/email")).body.unassigned;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ suggestedProjectId: acme, confidence: 0.7 });
    // Dismissing drops it without saving anything.
    expect(
      (await call(token, "POST", `/me/email/${waiting[0].id}/assign`, { projectId: null })).body,
    ).toEqual({ saved: 0 });
    expect((await call(token, "GET", "/me/email")).body.unassigned).toEqual([]);
  });

  it("asks for a reconnect when the Google link has no Gmail access, and keeps other people out", async () => {
    await start();
    // A link made before the Gmail scope was asked for.
    stack.oauth!.scope = "openid email profile drive.readonly";
    const token = await signInAsAda();
    await call(token, "POST", "/me/email/enabled", { enabled: true });
    await stack.email!.runDigest();
    expect((await call(token, "GET", "/me/email")).body).toMatchObject({
      enabled: true,
      needsReconnect: true,
    });
    expect(stack.email!.gmailCalls).toEqual([]);

    // The operator has no channel identity, so no mailbox.
    const operator = await call(stack.operatorToken, "POST", "/me/email/enabled", {
      enabled: true,
    });
    expect(operator.status).toBe(403);
    expect((await call("nope", "GET", "/me/email")).status).toBe(401);
  });
});

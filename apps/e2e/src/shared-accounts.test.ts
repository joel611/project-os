import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// An admin links a team GitHub account in the dashboard (the same OAuth flow as /connect), then
// assigns it to a person who has no GitHub link of their own. A Worker's `user_token` for that
// person's ticket returns the shared account's token, named as shared; a personal link always
// wins; the thread and audit log say which account was used.

let SECRET: string;
let WORKER: string;
const CHANNEL = "chan-1";
const THREAD = "discord-thread-1";
const bob = { channelId: CHANNEL, userId: "u-bob", name: "Bob" };

let stack: Stack;
beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request"), connections: true });
  ({ secret: SECRET, workerId: WORKER } = await stack.registerSharedWorker());
  await stack.linkChannel(CHANNEL);
});
afterEach(() => stack.stop());

const asOperator = (method: string, path: string, body?: unknown) =>
  fetch(`${stack.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${stack.operatorToken}`,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

/** The admin adds a shared GitHub account and finishes its OAuth flow as the bot's login. */
const addSharedGithub = async (label = "Ops bot") => {
  stack.oauth!.githubId = 900;
  stack.oauth!.githubLogin = "ops-bot";
  const res = await asOperator("POST", "/shared-accounts", { provider: "github", label });
  expect(res.status, await res.clone().text()).toBe(200);
  const created = (await res.json()) as { account: { id: string }; connectUrl: string };
  const page = await browse(created.connectUrl, undefined, "POST");
  expect(page.url).toContain("/connect/done?provider=github");
  stack.oauth!.githubId = 42;
  stack.oauth!.githubLogin = "ada-gh";
  return created.account.id;
};

const assign = (sharedAccountId: string | null) =>
  asOperator("POST", "/shared-accounts/assignments", {
    channelType: "discord",
    personId: "u-bob",
    provider: "github",
    sharedAccountId,
  });

const startTicket = async () => {
  await forwardInbound(stack.coordinator, fakeInbound(bob, "triage the GitHub issues")!, fetch);
  const [project] = await stack.json("GET", "/projects");
  const [ticket] = await stack.json("GET", `/projects/${project.id}/tickets`);
  const mcp = await stack.worker(SECRET);
  await mcp.callTool({
    name: "ticket_claim",
    arguments: { ticketId: ticket.id, workerId: WORKER },
  });
  return { mcp, ticketId: ticket.id as string };
};

type ToolResult = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
const userToken = async (mcp: Awaited<ReturnType<Stack["worker"]>>, ticketId: string) =>
  (await mcp.callTool({
    name: "user_token",
    arguments: { ticketId, provider: "github" },
  })) as ToolResult;

describe("shared connector accounts", () => {
  it("links a shared account, shows who it is, and keeps its tokens out of the listing", async () => {
    const id = await addSharedGithub();
    const view = (await (await asOperator("GET", "/shared-accounts")).json()) as any;
    expect(view.accounts).toEqual([
      expect.objectContaining({
        id,
        provider: "github",
        label: "Ops bot",
        identity: "ops-bot",
        connected: true,
      }),
    ]);
    expect(JSON.stringify(view)).not.toContain("at-github");
    // The shared account is not a person: it is no row on the Members page.
    const members = (await (await asOperator("GET", "/members")).json()) as any[];
    expect(members.map((m) => m.name)).not.toContain("Ops bot");
  });

  it("lists accounts by provider, then label", async () => {
    await addSharedGithub("Zed");
    const ada = await addSharedGithub("Ada");
    await assign(ada);
    const view = (await (await asOperator("GET", "/shared-accounts")).json()) as any;
    expect(view.accounts.map((a: { label: string }) => a.label)).toEqual(["Ada", "Zed"]);
    expect(view.assignments).toEqual([
      expect.objectContaining({ personId: "u-bob", provider: "github", sharedAccountId: ada }),
    ]);
  });

  it("is for Operators only", async () => {
    expect((await fetch(`${stack.url}/shared-accounts`)).status).toBe(401);
    const post = await fetch(`${stack.url}/shared-accounts/assignments`, { method: "POST" });
    expect(post.status).toBe(401);
  });

  it("gives a person with no GitHub link the shared account's token, and says so", async () => {
    const id = await addSharedGithub();
    const { mcp, ticketId } = await startTicket();

    // Not assigned yet: Bob is asked to /connect, as always.
    const denied = await userToken(mcp, ticketId);
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("NotConnected");

    expect((await assign(id)).status).toBe(200);
    const granted = await userToken(mcp, ticketId);
    expect(granted.isError).toBeFalsy();
    expect(granted.structuredContent).toMatchObject({
      accessToken: expect.stringMatching(/^at-github-/),
      person: { id: "u-bob", name: "Bob" },
      sharedAccount: { id, label: "Ops bot", identity: "ops-bot" },
    });

    // A blocked ticket names the account used, so it can be traced.
    await mcp.callTool({
      name: "ticket_update_status",
      arguments: { ticketId, status: "blocked", reason: "Need a repo the bot can't see." },
    });
    expect(stack.posted.at(-1)).toEqual({
      target: { channelId: CHANNEL, threadId: THREAD },
      content: expect.stringContaining(
        'Acting as <@u-bob> (Bob), via shared GitHub account "Ops bot" (ops-bot).',
      ),
    });

    // The audit log records who assigned it and that it was used (once for this ticket).
    await userToken(mcp, ticketId);
    const audit = (await (await asOperator("GET", "/audit?kind=connection")).json()) as {
      entries: Array<{ action: string; summary: string; actorName: string | null }>;
    };
    expect(audit.entries.map((e) => e.action).toSorted()).toEqual([
      "shared_account_added",
      "shared_account_assigned",
      "shared_account_used",
    ]);
    expect(audit.entries.find((e) => e.action === "shared_account_assigned")).toMatchObject({
      actorName: expect.any(String),
      summary: expect.stringContaining("discord:u-bob"),
    });
  });

  it("never replaces a personal link: that wins over an assigned shared account", async () => {
    const id = await addSharedGithub();
    await assign(id);
    const { mcp, ticketId } = await startTicket();

    // Bob links his own GitHub from Discord.
    const { forwardCommand } = await import("../../../packages/channel-discord/src/commands.ts");
    const { fakeCommand } = await import("../../../packages/channel-discord/src/fake.ts");
    const reply = await forwardCommand(
      stack.coordinator,
      fakeCommand(bob, "connect", { provider: "github" })!,
      fetch,
    );
    await browse(/(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)![1]!, undefined, "POST");

    const own = await userToken(mcp, ticketId);
    expect(own.structuredContent.sharedAccount).toBeUndefined();
    expect(own.structuredContent.person.id).toBe("u-bob");
  });

  it("asks an admin, not the person, to reconnect a shared account that stopped working", async () => {
    stack.oauth!.expiresIn = 1;
    const id = await addSharedGithub();
    await assign(id);
    const { mcp, ticketId } = await startTicket();
    await new Promise((r) => setTimeout(r, 1500));
    stack.oauth!.failRefresh = true;

    const denied = await userToken(mcp, ticketId);
    expect(denied.isError).toBe(true);
    expect(stack.posted.at(-1)).toEqual({
      target: { channelId: CHANNEL, threadId: THREAD },
      content: expect.stringMatching(
        /shared GitHub account "Ops bot".*An admin needs to reconnect/s,
      ),
    });
    expect(stack.posted.at(-1)!.content).not.toContain("/connect provider");
  });

  it("removing a shared account drops its assignments", async () => {
    const id = await addSharedGithub();
    await assign(id);
    expect((await asOperator("DELETE", `/shared-accounts/${id}`)).status).toBe(200);
    const view = (await (await asOperator("GET", "/shared-accounts")).json()) as any;
    expect(view).toEqual({ accounts: [], assignments: [] });
    const { mcp, ticketId } = await startTicket();
    expect((await userToken(mcp, ticketId)).isError).toBe(true);
    expect((await asOperator("DELETE", `/shared-accounts/${id}`)).status).toBe(404);
  });

  it("refuses a mismatched provider and unassigns cleanly", async () => {
    const id = await addSharedGithub();
    const wrong = await asOperator("POST", "/shared-accounts/assignments", {
      channelType: "discord",
      personId: "u-bob",
      provider: "google",
      sharedAccountId: id,
    });
    expect(wrong.status).toBe(400);
    expect((await assign(id)).status).toBe(200);
    expect((await assign(null)).status).toBe(200);
    const view = (await (await asOperator("GET", "/shared-accounts")).json()) as any;
    expect(view.assignments).toEqual([]);
  });

  it("rejects bad requests and unknown accounts", async () => {
    const blank = await asOperator("POST", "/shared-accounts", { provider: "github", label: "  " });
    expect(blank.status).toBe(400);
    const junk = await asOperator("POST", "/shared-accounts", { provider: "myspace", label: "x" });
    expect(junk.status).toBe(400);
    expect((await asOperator("POST", "/shared-accounts/assignments", { nope: 1 })).status).toBe(
      400,
    );
    expect((await asOperator("POST", "/shared-accounts/missing/connect")).status).toBe(404);
    expect((await assign("missing")).status).toBe(404);
    // Unassigning someone who had nothing is a no-op, and isn't logged.
    expect((await assign(null)).status).toBe(200);
    const audit = (await (await asOperator("GET", "/audit?kind=connection")).json()) as any;
    expect(audit.entries).toEqual([]);
  });

  it("hands out a fresh link to finish connecting an account, and asks an admin while it is not", async () => {
    const res = await asOperator("POST", "/shared-accounts", {
      provider: "github",
      label: "Ops bot",
    });
    const { account } = (await res.json()) as { account: { id: string; connected: boolean } };
    // Never finished: listed as not connected; a Worker for an assigned person gets nothing.
    expect(account.connected).toBe(false);
    await assign(account.id);
    const { mcp, ticketId } = await startTicket();
    expect((await userToken(mcp, ticketId)).isError).toBe(true);
    expect(stack.posted.at(-1)!.content).toContain("An admin needs to reconnect");

    stack.oauth!.githubId = 900;
    stack.oauth!.githubLogin = "ops-bot";
    const again = await asOperator("POST", `/shared-accounts/${account.id}/connect`);
    const { connectUrl } = (await again.json()) as { connectUrl: string };
    await browse(connectUrl, undefined, "POST");
    const granted = await userToken(mcp, ticketId);
    expect(granted.structuredContent.sharedAccount).toMatchObject({ label: "Ops bot" });
  });
});

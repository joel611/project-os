import { Database } from "bun:sqlite";
import { IntentClassifier } from "@project-os/core";
import { makeSkillSourceFake } from "@project-os/testing";
import { Effect, Layer } from "effect";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

const skillMd = "---\nname: tdd\ndescription: Test first\n---\n# Test first";
const classifier = Layer.succeed(IntentClassifier, {
  classify: ({ taskTypes = [] }) =>
    Effect.succeed({
      intent: "new_request",
      confidence: 1,
      ...(taskTypes[0] && { taskType: { choice: taskTypes[0].id, confidence: 1 } }),
    }),
});

let stack: Stack | undefined;
let github: ReturnType<typeof Bun.serve> | undefined;
const requests: Array<{ host: string; path: string; authorization: string | null }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await stack?.stop();
  github?.stop(true);
  stack = undefined;
  github = undefined;
  requests.length = 0;
});

const start = async (token?: string) => {
  github = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      const [, host, ...parts] = url.pathname.split("/");
      const path = `/${parts.join("/")}`;
      requests.push({ host: host!, path, authorization: req.headers.get("authorization") });
      if (host === "raw.githubusercontent.com") return new Response(skillMd);
      if (path === "/repos/acme/skills") return Response.json({ default_branch: "main" });
      if (path === "/repos/acme/skills/git/trees/main")
        return Response.json({
          tree: [
            { path: "skills/tdd", type: "tree", sha: "tree-tdd", mode: "040000" },
            { path: "skills/tdd/SKILL.md", type: "blob", sha: "blob-md", mode: "100644" },
          ],
        });
      if (path === "/repos/acme/skills/git/blobs/blob-md") {
        return Response.json({ content: btoa(skillMd), encoding: "base64" });
      }
      return new Response("Unexpected GitHub request", { status: 500 });
    },
  });
  stack = await startStack({
    classifier,
    connections: true,
    githubSkills: {
      ...(token && { token }),
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (!["api.github.com", "raw.githubusercontent.com"].includes(url.hostname)) {
          throw new Error(`Unexpected skill host ${url.hostname}`);
        }
        return fetch(
          `http://localhost:${github!.port}/${url.hostname}${url.pathname}${url.search}`,
          init,
        );
      }) as typeof fetch,
    },
  });
  return stack;
};

const createShared = (label = "Ops bot", provider = "github") =>
  stack!.json("POST", "/shared-accounts", { provider, label }) as Promise<{
    account: { id: string };
    connectUrl: string;
  }>;

const linkShared = async (identity = 900, label = "Ops bot") => {
  stack!.oauth!.githubId = identity;
  stack!.oauth!.githubLogin = `bot-${identity}`;
  const created = await createShared(label);
  const page = await browse(created.connectUrl, undefined, "POST");
  expect(page.url).toContain("/connect/done?provider=github");
  return created.account.id;
};

const browseSkills = () => stack!.json("POST", "/task-types/browse", { source: "acme/skills" });
const apiAuth = () =>
  requests.filter((r) => r.host === "api.github.com").map((r) => r.authorization);
const expectApiAuth = (token: string | null) => {
  expect(apiAuth().length).toBeGreaterThan(0);
  expect(new Set(apiAuth())).toEqual(new Set([token]));
  const rawAuth = requests
    .filter((r) => r.host === "raw.githubusercontent.com")
    .map((r) => r.authorization);
  expect(rawAuth.length).toBeGreaterThan(0);
  expect(new Set(rawAuth)).toEqual(new Set([null]));
};

describe("tasktype shared GitHub credentials", () => {
  it("rejects mutually exclusive skill source providers", async () => {
    await expect(
      startStack({
        classifier,
        skillSource: makeSkillSourceFake().service,
        githubSkills: { fetch },
      }),
    ).rejects.toEqual(new Error("skillSource and githubSkills are mutually exclusive"));
  });

  it("uses an account linked after startup to browse, import and deliver skills without leaking its token", async () => {
    const s = await start();
    await browseSkills();
    expectApiAuth(null);
    await linkShared();
    requests.length = 0;
    const guardedFetch = globalThis.fetch;
    const profileRequests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/userinfo")) profileRequests.push(url);
      return guardedFetch(input, init);
    }) as typeof fetch);

    const found = await browseSkills();
    expect(found.skills).toEqual([expect.objectContaining({ slug: "tdd", name: "tdd" })]);
    const set = await s.json("POST", "/task-types", { name: "development", description: "Code" });
    const imported = await s.json("POST", `/task-types/${set.id}/skills`, {
      source: "acme/skills",
      slugs: ["tdd"],
    });
    expect(imported.skills).toHaveLength(1);
    expectApiAuth("Bearer at-github-1");
    expect(requests.some((r) => r.path.endsWith("/git/blobs/blob-md"))).toBe(true);
    expect(profileRequests).toEqual([]);
    expect(JSON.stringify({ found, imported })).not.toMatch(/at-github|rt-github/);

    const { secret } = await s.registerSharedWorker();
    const projectId = await s.linkChannel("skills-channel");
    await forwardInbound(
      s.coordinator,
      fakeInbound(
        {
          channelId: "skills-channel",
          userId: "ada",
          name: "Ada",
        },
        "write code",
      )!,
      fetch,
    );
    const [ticket] = await s.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket.taskTypeId).toBe(set.id);
    const bundle = await fetch(`${s.url}/tickets/${ticket.id}/skills`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(bundle.status).toBe(200);
    const files = Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(await bundle.arrayBuffer()))).map(
        ([path, contents]) => [path, strFromU8(contents)],
      ),
    );
    expect(files).toEqual({ "tdd/SKILL.md": skillMd });
    expect(JSON.stringify(files)).not.toMatch(/at-github|rt-github/);
  });

  it("prefers shared credentials over PAT and observes removal and reconnect without restart", async () => {
    await start("static-pat");
    await browseSkills();
    expectApiAuth("Bearer static-pat");
    const id = await linkShared();
    requests.length = 0;
    await browseSkills();
    expectApiAuth("Bearer at-github-1");
    const { connectUrl } = await stack!.json("POST", `/shared-accounts/${id}/connect`);
    await browse(connectUrl, undefined, "POST");
    requests.length = 0;
    await browseSkills();
    expectApiAuth("Bearer at-github-2");
    await stack!.json("DELETE", `/shared-accounts/${id}`);
    requests.length = 0;
    await browseSkills();
    expectApiAuth("Bearer static-pat");
  });

  it.each([undefined, "static-pat"])("excludes personal accounts with PAT %s", async (pat) => {
    const s = await start(pat);
    await s.linkChannel("personal-channel");
    const reply = await forwardCommand(
      s.coordinator,
      fakeCommand(
        {
          channelId: "personal-channel",
          userId: "ada",
          name: "Ada",
        },
        "connect",
        { provider: "github" },
      )!,
      fetch,
    );
    await browse(/(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)![1]!, undefined, "POST");
    await browseSkills();
    expectApiAuth(pat ? `Bearer ${pat}` : null);
  });

  it("skips disconnected rows and other providers, then returns to anonymous after removal", async () => {
    await start();
    await createShared("Not connected");
    const google = await createShared("Google", "google");
    await browse(google.connectUrl, undefined, "POST");
    const connected = await linkShared();
    await browseSkills();
    expectApiAuth("Bearer at-github-2");
    await stack!.json("DELETE", `/shared-accounts/${connected}`);
    requests.length = 0;
    await browseSkills();
    expectApiAuth(null);
  });

  it("selects oldest usable shared account, breaking equal timestamps by id rather than label", async () => {
    await start("static-pat");
    const first = await linkShared(900, "Zed");
    const second = await linkShared(901, "Ada");
    await browseSkills();
    expectApiAuth("Bearer at-github-1");
    const db = new Database(stack!.dbPath);
    try {
      db.query("UPDATE shared_accounts SET created_at = ? WHERE id = ?").run("2000-01-01", second);
      requests.length = 0;
      await browseSkills();
      expectApiAuth("Bearer at-github-2");
      db.query("UPDATE shared_accounts SET created_at = ?").run("2000-01-01");
      requests.length = 0;
      await browseSkills();
      expectApiAuth(first < second ? "Bearer at-github-1" : "Bearer at-github-2");
    } finally {
      db.close();
    }
  });

  it("refreshes expired shared credentials through OAuth before sending GitHub requests", async () => {
    const s = await start("static-pat");
    s.oauth!.expiresIn = 1;
    await linkShared();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    s.oauth!.expiresIn = 3600;
    await browseSkills();
    expectApiAuth("Bearer at-github-2");
    expect(s.oauth!.tokenRequests).toEqual([
      { provider: "github", grantType: "authorization_code" },
      { provider: "github", grantType: "refresh_token" },
    ]);
  });

  it.each([undefined, "static-pat"])(
    "skips failed refreshes, trying next shared account before PAT %s",
    async (pat) => {
      const s = await start(pat);
      s.oauth!.expiresIn = 1;
      await linkShared();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      s.oauth!.expiresIn = 3600;
      const second = await linkShared(901);
      s.oauth!.failRefresh = true;
      await browseSkills();
      expectApiAuth("Bearer at-github-2");
      expect(s.oauth!.tokenRequests).toContainEqual({
        provider: "github",
        grantType: "refresh_token",
      });
      await s.json("DELETE", `/shared-accounts/${second}`);
      requests.length = 0;
      await browseSkills();
      expectApiAuth(pat ? `Bearer ${pat}` : null);
    },
  );
});

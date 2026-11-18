import { describe, expect, it, vi } from "vite-plus/test";
import { ApiError, apiBase, describeError, makeApi } from "./api.ts";

const T = "2026-11-05T00:00:00.000Z";
const project = {
  id: "p1",
  orgId: "o1",
  name: "Acme",
  slug: null,
  customInstructions: "",
  defaultResponseChannelId: null,
  channelDigest: true,
  channelDigestNotify: false,
  status: "active",
  createdBy: null,
  createdAt: T,
  updatedAt: T,
};

const respond = (status: number, body: unknown, statusText = "") => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      statusText,
    });
  }) as typeof fetch;
  return { api: makeApi(fetchFn), calls };
};

describe("makeApi", () => {
  it("decodes responses with the contract schemas, under /api", async () => {
    const { api, calls } = respond(200, [project]);
    expect(await api.projects()).toEqual([project]);
    expect(calls).toEqual(["/api/projects"]);
  });

  it("reads who is signed in and their own tickets", async () => {
    const viewer = { role: "member", name: "Ada", person: null };
    const me = respond(200, viewer);
    expect(await me.api.me()).toEqual(viewer);
    expect(me.calls).toEqual(["/api/me"]);
    const mine = respond(200, { tickets: [], projects: [{ id: "p1", name: "Acme" }] });
    expect(await mine.api.myTickets()).toEqual({
      tickets: [],
      projects: [{ id: "p1", name: "Acme" }],
    });
    expect(mine.calls).toEqual(["/api/me/tickets"]);
  });

  it("picks the API base from the Coordinator URL, else /api", () => {
    expect(apiBase(undefined)).toBe("/api");
    expect(apiBase("")).toBe("/api");
    expect(apiBase("https://coord.example.com/")).toBe("https://coord.example.com");
  });

  it("calls the Coordinator directly when given a base URL", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return Response.json([]);
    }) as unknown as typeof fetch;
    await makeApi(fetchFn, "https://coord.example.com").projects();
    expect(calls).toEqual(["https://coord.example.com/projects"]);
  });

  it("uses the global fetch by default", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json([])) as unknown as typeof fetch;
    try {
      expect(await makeApi().projects()).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("encodes ids into paths for every resource", async () => {
    const { api, calls } = respond(500, { error: "Boom" });
    const all = [
      api.project("a/b"),
      api.tickets("a/b"),
      api.memory("a/b"),
      api.projectAudit("a/b"),
      api.projectAudit("a/b", { kind: "ticket", before: "12" }),
      api.audit(),
      api.audit({ kind: "worker", projectId: "a/b" }),
      api.members(),
      api.ticket("t 1"),
      api.ticketAttachments("t 1"),
      api.workers(),
      api.worker("w/1"),
      api.workerAudit("w/1"),
      api.workerAudit("w/1", { kind: "ticket" }),
    ];
    await Promise.allSettled(all);
    expect(calls).toEqual([
      "/api/projects/a%2Fb",
      "/api/projects/a%2Fb/tickets",
      "/api/projects/a%2Fb/memory",
      "/api/projects/a%2Fb/audit",
      "/api/projects/a%2Fb/audit?kind=ticket&before=12",
      "/api/audit",
      "/api/audit?kind=worker&projectId=a%2Fb",
      "/api/members",
      "/api/tickets/t%201",
      "/api/tickets/t%201/attachments",
      "/api/workers",
      "/api/workers/w%2F1",
      "/api/workers/w%2F1/audit",
      "/api/workers/w%2F1/audit?kind=ticket",
    ]);
  });

  it("PATCHes project settings and POSTs sources as JSON", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const source = {
      id: "s1",
      projectId: "p1",
      type: "github_repo",
      externalId: "acme/web",
      name: "acme/web",
      alias: "web",
      description: null,
      direction: "both",
      isDefaultResponse: false,
      config: null,
      status: "active",
      connectedBy: null,
      createdAt: T,
      updatedAt: T,
    };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      const isProject = init?.method === "PATCH" && !url.includes("/sources/");
      return Response.json(isProject ? project : source, { status: 200 });
    }) as typeof fetch;
    const api = makeApi(fetchFn);
    await api.updateProject("p1", { name: "Acme" });
    await api.addSource("p1", {
      type: "github_repo",
      externalId: "acme/web",
      name: "acme/web",
      alias: "web",
    });
    await api.updateSource("p1", "s1", { description: "the marketing site" });
    expect(await api.removeSource("p1", "s1")).toEqual(source);
    expect(seen.map((s) => [s.url, s.init?.method])).toEqual([
      ["/api/projects/p1", "PATCH"],
      ["/api/projects/p1/sources", "POST"],
      ["/api/projects/p1/sources/s1", "PATCH"],
      ["/api/projects/p1/sources/s1", "DELETE"],
    ]);
    expect(seen[3]?.init?.body).toBeUndefined();
    expect(seen[3]?.init?.headers).not.toHaveProperty("content-type");
    expect(JSON.parse(String(seen[2]?.init?.body))).toEqual({ description: "the marketing site" });
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ name: "Acme" });
  });

  it("POSTs the worker to assign a ticket to and decodes the ticket back", async () => {
    const ticket = {
      id: "t/1",
      projectId: "p1",
      status: "assigned",
      title: "x",
      intent: null,
      inputSummary: "x",
      priority: null,
      workerType: "local",
      workerId: "w2",
      requester: null,
      result: null,
      error: null,
      createdAt: T,
      assignedAt: T,
      startedAt: null,
      lastActivityAt: T,
      completedAt: null,
      updatedAt: T,
    };
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return Response.json(ticket);
    }) as unknown as typeof fetch;
    expect(await makeApi(fetchFn).assignTicket("t/1", "w2")).toEqual(ticket);
    expect(seen.map((s) => [s.url, s.init?.method])).toEqual([
      ["/api/tickets/t%2F1/assign", "POST"],
    ]);
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ workerId: "w2" });
  });

  it("decodes worker status alongside the worker", async () => {
    const worker = {
      id: "w1",
      workerType: "local",
      ownerChannelType: null,
      ownerId: null,
      registered: false,
      name: null,
      currentTicketId: null,
      lastSeenAt: T,
      createdAt: T,
      status: "online",
    };
    const { api } = respond(200, [worker]);
    expect(await api.workers()).toEqual([worker]);
    const detail = respond(200, { worker, tickets: [] });
    expect(await detail.api.worker("w1")).toEqual({ worker, tickets: [] });
  });

  it("reads the activity feed, passing the previous read's time as since", async () => {
    const feed = { now: T, tickets: [], events: [], workers: [] };
    const { api, calls } = respond(200, feed);
    expect(await api.activity(null)).toEqual(feed);
    await api.activity(T);
    expect(calls).toEqual(["/api/activity", `/api/activity?since=${encodeURIComponent(T)}`]);
  });

  it("surfaces the Coordinator's tagged error", async () => {
    const { api } = respond(404, { error: "ProjectNotFound" });
    await expect(api.project("nope")).rejects.toEqual(new ApiError(404, "ProjectNotFound"));
  });

  it("falls back to the status text when the error body is not the Coordinator's", async () => {
    const { api } = respond(500, "<html>oops</html>", "Internal Server Error");
    await expect(api.projects()).rejects.toMatchObject({ code: "Internal Server Error" });
  });

  it("reads a bare gateway error as the Coordinator being unreachable", async () => {
    const { api } = respond(502, "", "Bad Gateway");
    await expect(api.projects()).rejects.toMatchObject({ status: 502, code: "Unreachable" });
  });

  it("keeps the Coordinator's own 502 tag", async () => {
    const { api } = respond(502, { error: "AgentRuntimeError" });
    await expect(api.projects()).rejects.toMatchObject({ code: "AgentRuntimeError" });
  });

  it("rejects a response that drifted from the contract", async () => {
    const { api } = respond(200, [{ ...project, status: "bogus" }]);
    await expect(api.projects()).rejects.toThrow();
  });
});

describe("session", () => {
  const recording = (status: number, body: unknown = []) => {
    const headers: Array<string | null> = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get("authorization"));
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    return { fetchFn, headers };
  };

  it("sends the session token as a Bearer header, and none without one", async () => {
    const { fetchFn, headers } = recording(200);
    const expired = vi.fn();
    await makeApi(fetchFn, "/api", { token: () => "tok-1", expired }).projects();
    await makeApi(fetchFn, "/api", { token: () => null, expired }).projects();
    expect(headers).toEqual(["Bearer tok-1", null]);
    expect(expired).not.toHaveBeenCalled();
  });

  it("reports a 401 as an ended session and still fails the call", async () => {
    const { fetchFn } = recording(401, { error: "Unauthorized" });
    const expired = vi.fn();
    const api = makeApi(fetchFn, "/api", { token: () => "stale", expired });
    await expect(api.workers()).rejects.toEqual(new ApiError(401, "Unauthorized"));
    expect(expired).toHaveBeenCalledOnce();
  });

  it("does not end the session on a 403 or other errors", async () => {
    const expired = vi.fn();
    for (const status of [403, 500]) {
      const { fetchFn } = recording(status, { error: "Nope" });
      await makeApi(fetchFn, "/api", { token: () => "t", expired })
        .projects()
        .catch(() => undefined);
    }
    expect(expired).not.toHaveBeenCalled();
  });
});

describe("describeError", () => {
  const unreachable = "Can't reach the Coordinator. Is it running?";

  it.each([
    [new TypeError("Failed to fetch"), unreachable],
    [new ApiError(502, "Unreachable"), unreachable],
    [new ApiError(401, "Unauthorized"), "Your session ended. Sign in again."],
    [new ApiError(403, "Forbidden"), "This account isn't allowed to use the dashboard."],
    [new ApiError(404, "TicketNotFound"), "Not found."],
    [new ApiError(409, "SourceAlreadyLinked"), "That source is already linked to a project."],
    [new ApiError(409, "SkillSetNameTaken"), "A skill set with that name already exists."],
    [new ApiError(400, "InvalidSkillSet"), 'Use a name of 1 to 60 characters, other than "none".'],
    [
      new ApiError(400, "InvalidSkillSource"),
      "Use owner/repo, or a skills.sh or github.com link to a repo.",
    ],
    [
      new ApiError(502, "SkillFetchFailed"),
      "Couldn't read that from GitHub (not found, too large, or rate limited).",
    ],
    [new ApiError(400, "SchemaError"), "The Coordinator rejected that input."],
    [new ApiError(502, "AgentRuntimeError"), "Coordinator returned 502 (AgentRuntimeError)."],
  ])("%s → %s", (error, message) => {
    expect(describeError(error)).toBe(message);
  });

  it("reports contract drift as an unexpected response, not as unreachable", async () => {
    const { api } = respond(200, [{ ...project, status: "bogus" }]);
    const error = await api.projects().catch((e: Error) => e);
    expect(describeError(error as Error)).toMatch(/^Unexpected response from the Coordinator: /);
  });
});

describe("skill set calls", () => {
  const T = "2026-11-04T00:00:00.000Z";
  const set = { id: "s1", name: "dev", description: "", createdAt: T, updatedAt: T };
  const skill = {
    id: "k1",
    skillSetId: "s1",
    source: "acme/skills",
    slug: "tdd",
    name: "tdd",
    description: "",
    path: "skills/tdd",
    sha: "t1",
    archiveKey: "skills/s1/k1/t1.zip",
    fileCount: 1,
    bytes: 3,
    fetchedAt: T,
    fetchedBy: null,
  };

  it("calls each route with its method and body", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const answers: Record<string, unknown> = {
      "GET /api/skill-sets": { sets: [{ set, skills: [skill] }] },
      "POST /api/skill-sets": set,
      "PATCH /api/skill-sets/s1": set,
      "DELETE /api/skill-sets/s1": { deleted: true },
      "POST /api/skill-sets/browse": { source: "acme/skills", skills: [] },
      "POST /api/skill-sets/s1/skills": { skills: [skill] },
      "DELETE /api/skill-sets/s1/skills/k1": { deleted: true },
      "GET /api/skill-sets/s1/updates": {
        statuses: [{ skillId: "k1", state: "current", latestSha: "t1" }],
      },
      "POST /api/skill-sets/s1/update": { skills: [] },
    };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      seen.push({ url, method, body: init?.body && JSON.parse(String(init.body)) });
      return Response.json(answers[`${method} ${url}`]);
    }) as typeof fetch;
    const api = makeApi(fetchFn);
    expect((await api.skillSets()).sets).toHaveLength(1);
    await api.createSkillSet({ name: "dev", description: "" });
    await api.updateSkillSet("s1", { name: "dev" });
    expect(await api.deleteSkillSet("s1")).toEqual({ deleted: true });
    await api.browseSkills("acme/skills");
    await api.addSkills("s1", { source: "acme/skills", slugs: ["tdd"] });
    await api.removeSkill("s1", "k1");
    expect((await api.skillUpdates("s1")).statuses[0]!.state).toBe("current");
    await api.updateSkills("s1");
    await api.updateSkills("s1", ["k1"]);
    expect(seen.map((s) => s.body)).toEqual([
      undefined,
      { name: "dev", description: "" },
      { name: "dev" },
      undefined,
      { source: "acme/skills" },
      { source: "acme/skills", slugs: ["tdd"] },
      undefined,
      undefined,
      {},
      { skillIds: ["k1"] },
    ]);
  });
});

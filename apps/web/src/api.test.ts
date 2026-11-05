import { describe, expect, it } from "vite-plus/test";
import { ApiError, describeError, makeApi } from "./api.ts";

const T = "2026-11-05T00:00:00.000Z";
const project = {
  id: "p1",
  orgId: "o1",
  name: "Acme",
  slug: null,
  customInstructions: "",
  defaultResponseChannelId: null,
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
      api.ticket("t 1"),
      api.workers(),
    ];
    await Promise.allSettled(all);
    expect(calls).toEqual([
      "/api/projects/a%2Fb",
      "/api/projects/a%2Fb/tickets",
      "/api/projects/a%2Fb/memory",
      "/api/tickets/t%201",
      "/api/workers",
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
      return Response.json(init?.method === "PATCH" ? project : source, { status: 200 });
    }) as typeof fetch;
    const api = makeApi(fetchFn);
    await api.updateProject("p1", { name: "Acme" });
    await api.addSource("p1", { type: "github_repo", externalId: "acme/web", name: "acme/web" });
    expect(seen.map((s) => [s.url, s.init?.method])).toEqual([
      ["/api/projects/p1", "PATCH"],
      ["/api/projects/p1/sources", "POST"],
    ]);
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ name: "Acme" });
  });

  it("decodes worker status alongside the worker", async () => {
    const worker = {
      id: "w1",
      workerType: "local_claude",
      currentTicketId: null,
      lastSeenAt: T,
      createdAt: T,
      status: "online",
    };
    const { api } = respond(200, [worker]);
    expect(await api.workers()).toEqual([worker]);
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

describe("describeError", () => {
  const unreachable = "Can't reach the Coordinator. Is it running?";

  it.each([
    [new TypeError("Failed to fetch"), unreachable],
    [new ApiError(502, "Unreachable"), unreachable],
    [new ApiError(404, "TicketNotFound"), "Not found."],
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

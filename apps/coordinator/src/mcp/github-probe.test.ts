import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { describeProbe, probeGithub } from "./github-probe.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const serve = (fetch: (req: Request) => Response) => {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return `http://localhost:${server.port}`;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});

describe("probeGithub", () => {
  it("reports the account, installations and each repo's status", async () => {
    const api = serve((req) => {
      const path = new URL(req.url).pathname;
      const headers = { "x-github-request-id": "r1", "x-oauth-scopes": "repo" };
      if (path === "/user") return Response.json({ login: "ada" }, { headers });
      if (path === "/user/installations") {
        return Response.json(
          { installations: [{ account: { login: "ada" }, repository_selection: "all" }, {}] },
          { headers },
        );
      }
      return new Response("nope", { status: 404, headers });
    });
    expect(await probeGithub(api, "tok", ["a/b"])).toEqual({
      login: "ada",
      scopes: "repo",
      user: { status: 200, requestId: "r1" },
      installations: {
        status: 200,
        requestId: "r1",
        accounts: [
          { account: "ada", selection: "all" },
          { account: "?", selection: "?" },
        ],
      },
      repos: [{ repo: "a/b", status: 404, requestId: "r1" }],
    });
  });

  it("copes with bodies that are not JSON", async () => {
    const api = serve(() => new Response("<html>"));
    const probe = await probeGithub(api, "tok", []);
    expect(probe).toMatchObject({
      login: null,
      user: { status: 200 },
      installations: { accounts: [] },
      repos: [],
    });
  });

  it("records status 0 when GitHub cannot be reached, for Error and non-Error failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockRejectedValueOnce(new Error("connection refused"));
    fetchSpy.mockRejectedValueOnce("weird");
    const probe = await probeGithub("http://localhost:1", "tok", []);
    expect(probe.user.status).toBe(0);
    expect(probe.installations.status).toBe(0);
  });
});

describe("describeProbe", () => {
  it("says what each part answered", () => {
    expect(
      describeProbe({
        login: null,
        scopes: null,
        user: { status: 401, requestId: null },
        installations: { status: 403, requestId: null, accounts: [] },
        repos: [],
      }),
    ).toBe(
      "GitHub access check (GET /user answered 401): no repo sources. " +
        "App installations: none (GET /user/installations answered 403).",
    );
  });
});

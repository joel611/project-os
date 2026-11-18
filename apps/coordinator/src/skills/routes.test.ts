import {
  addSkillsToSet,
  createSkillSet,
  issueSandboxToken,
  ProjectRepository,
  TicketRepository,
  type Ticket,
} from "@project-os/core";
import { makeSkillSourceFake, makeTestLayer } from "@project-os/testing";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { McpRuntime } from "../mcp/server.ts";
import { skillRoutes } from "./routes.ts";

const T0 = "2026-11-04T00:00:00.000Z";

const source = makeSkillSourceFake({
  "acme/skills": [
    {
      path: "skills/tdd",
      sha: "t1",
      files: [{ path: "SKILL.md", contents: "---\nname: tdd\n---\n# tdd" }],
    },
  ],
});

let runtime: ManagedRuntime.ManagedRuntime<any, never>;
afterEach(() => runtime.dispose());

const ticket = (id: string, workerId: string, skillSetId: string | null): Ticket => ({
  id,
  projectId: "p1",
  status: "assigned",
  title: id,
  intent: null,
  inputSummary: "",
  priority: null,
  workerType: "daytona_pi",
  workerId,
  skillSetId,
  requester: null,
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: T0,
  startedAt: null,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
});

const seed = async () => {
  runtime = ManagedRuntime.make(makeTestLayer({ skillSource: source }).layer);
  return runtime.runPromise(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert({
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
        createdAt: T0,
        updatedAt: T0,
      });
      const set = yield* createSkillSet({ name: "dev", description: "code" });
      yield* addSkillsToSet({ setId: set.id, source: "acme/skills", slugs: ["tdd"], by: null });
      const tickets = yield* TicketRepository;
      yield* tickets.insert(ticket("t1", "daytona-t1", set.id));
      yield* tickets.insert(ticket("t2", "daytona-t2", null));
      return {
        set,
        token: yield* issueSandboxToken("daytona-t1", 600),
      };
    }),
  );
};

const get = (path: string, token?: string) =>
  skillRoutes({ runtime: runtime as unknown as McpRuntime }).handle(
    new Request(`http://localhost${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );

describe("GET /tickets/:id/skills", () => {
  it("gives a sandbox session the pinned skills of its ticket's set", async () => {
    const { set, token } = await seed();
    const res = await get("/tickets/t1/skills", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      set: { id: set.id, name: "dev" },
      skills: [
        {
          slug: "tdd",
          name: "tdd",
          files: [{ path: "SKILL.md", contents: "---\nname: tdd\n---\n# tdd" }],
        },
      ],
    });
  });

  it("gives an empty bundle for a ticket with no set", async () => {
    const { token } = await seed();
    const own = await runtime.runPromise(issueSandboxToken("daytona-t2", 600));
    void token;
    const res = await get("/tickets/t2/skills", own);
    expect(await res.json()).toEqual({ set: null, skills: [] });
  });

  it("refuses a caller with no valid token", async () => {
    await seed();
    expect((await get("/tickets/t1/skills")).status).toBe(401);
    expect((await get("/tickets/t1/skills", "nope")).status).toBe(401);
  });

  it("refuses another worker's ticket, and says when there is no such ticket", async () => {
    const { token } = await seed();
    const other = await get("/tickets/t2/skills", token);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toBe("WorkerUnauthorized");
    const missing = await get("/tickets/nope/skills", token);
    expect(missing.status).toBe(404);
  });
});

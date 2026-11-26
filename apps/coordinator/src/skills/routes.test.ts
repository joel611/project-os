import { strFromU8, unzipSync } from "fflate";
import {
  addSkillsToSet,
  SkillRepository,
  createTaskType,
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

const ticket = (id: string, workerId: string, taskTypeId: string | null): Ticket => ({
  id,
  projectId: "p1",
  status: "assigned",
  title: id,
  intent: null,
  inputSummary: "",
  priority: null,
  workerType: "daytona_pi",
  workerId,
  taskTypeId,
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
      const set = yield* createTaskType({
        name: "dev",
        description: "code",
        instructions: "Use tdd first.",
      });
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
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(decodeURIComponent(res.headers.get("x-task-type")!)).toBe("dev");
    void set;
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(["tdd/SKILL.md"]);
    expect(strFromU8(files["tdd/SKILL.md"]!)).toBe("---\nname: tdd\n---\n# tdd");
  });

  it("says there is nothing to install for a ticket with no set", async () => {
    const { token } = await seed();
    const own = await runtime.runPromise(issueSandboxToken("daytona-t2", 600));
    void token;
    const res = await get("/tickets/t2/skills", own);
    expect(res.status).toBe(204);
  });

  it("says 502 when the stored skills can't be read", async () => {
    const { token } = await seed();
    // Every stored zip is gone.
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* SkillRepository;
        for (const skill of yield* repo.listSkills((yield* repo.listSets)[0]!.id)) {
          yield* repo.upsertSkill({ ...skill, archiveKey: "skills/gone.zip" });
        }
      }),
    );
    const res = await get("/tickets/t1/skills", token);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("SkillFetchFailed");
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

describe("GET /tickets/:id/task-type", () => {
  it("gives a session its ticket's task type with the instructions for its prompt", async () => {
    const { set, token } = await seed();
    const res = await get("/tickets/t1/task-type", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: set.id,
      name: "dev",
      instructions: "Use tdd first.",
    });
  });

  it("says there is nothing for a ticket with no task type", async () => {
    await seed();
    const own = await runtime.runPromise(issueSandboxToken("daytona-t2", 600));
    expect((await get("/tickets/t2/task-type", own)).status).toBe(204);
  });

  it("refuses another worker's ticket, and says when there is no such ticket", async () => {
    const { token } = await seed();
    const other = await get("/tickets/t2/task-type", token);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toBe("WorkerUnauthorized");
    expect((await get("/tickets/nope/task-type", token)).status).toBe(404);
  });
});

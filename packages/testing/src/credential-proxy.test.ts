import {
  egressAccessToken,
  type McpCaller,
  ProjectRepository,
  TicketRepository,
  type Ticket,
} from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";

const ticket = (
  id: string,
  workerId: string,
  status: Ticket["status"] = "in_progress",
): Ticket => ({
  id,
  projectId: "p1",
  status,
  title: `Ticket ${id}`,
  intent: null,
  inputSummary: "",
  priority: null,
  workerType: "daytona_pi",
  workerId,
  requester: null,
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: T0,
  startedAt: T0,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
});

const sandbox: McpCaller = { id: "daytona-t1", kind: "sandbox" };
const device: McpCaller = { id: "w-box", kind: "device" };

/** Runs `egressAccessToken` with Ada linked to GitHub and the given tickets, each from Ada. */
const run = async (
  tickets: ReadonlyArray<Ticket>,
  input: { readonly caller: McpCaller; readonly ticketId?: string },
) => {
  const t = makeTestLayer();
  t.link({ channelType: "discord", id: "u-ada" }, "github", "tok-ada");
  return Effect.runPromise(
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
      const repo = yield* TicketRepository;
      for (const t of tickets) {
        yield* repo.insert(t);
        yield* repo.appendEvent({
          id: `e-${t.id}`,
          ticketId: t.id,
          type: "created",
          actor: "coordinator",
          actorId: null,
          body: "",
          payload: { sender: { id: "u-ada", name: "Ada" }, channelType: "discord" },
          createdAt: T0,
        });
      }
      return yield* egressAccessToken({ ...input, provider: "github" }).pipe(
        Effect.catch((e: { _tag: string }) => Effect.succeed(`error:${e._tag}`)),
      );
    }).pipe(Effect.provide(t.layer)) as Effect.Effect<string>,
  );
};

describe("credential proxy token", () => {
  it("acts for a sandbox session's only open ticket without being told which", async () => {
    expect(await run([ticket("t1", sandbox.id)], { caller: sandbox })).toBe("tok-ada");
  });

  it("ignores tickets the worker has finished", async () => {
    const tickets = [ticket("t0", sandbox.id, "completed"), ticket("t1", sandbox.id)];
    expect(await run(tickets, { caller: sandbox })).toBe("tok-ada");
  });

  it("refuses a worker with no open ticket", async () => {
    expect(await run([ticket("t1", "someone-else")], { caller: sandbox })).toBe(
      "error:EgressTicketUnknown",
    );
  });

  it("needs a named ticket when a device holds several", async () => {
    const tickets = [ticket("t1", device.id), ticket("t2", device.id, "assigned")];
    expect(await run(tickets, { caller: device })).toBe("error:EgressTicketUnknown");
    expect(await run(tickets, { caller: device, ticketId: "t2" })).toBe("tok-ada");
  });

  it("refuses a named ticket assigned to another worker", async () => {
    const tickets = [ticket("t1", sandbox.id), ticket("t2", "other")];
    expect(await run(tickets, { caller: sandbox, ticketId: "t2" })).toBe(
      "error:WorkerUnauthorized",
    );
  });
});

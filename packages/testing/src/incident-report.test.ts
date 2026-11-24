import {
  audit,
  auditRuntimeError,
  incidentReport,
  ProjectRepository,
  type Project,
} from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { classifierReturning, makeTestLayer } from "./index.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const AT = NOW.toISOString();
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

const project: Project = {
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
  createdAt: AT,
  updatedAt: AT,
};

const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(project);
      return yield* effect;
    }).pipe(
      Effect.provide(
        makeTestLayer({ now: NOW, classifier: classifierReturning("new_request") }).layer,
      ),
    ) as Effect.Effect<A, E, never>,
  );

const errorRow = (at: string, extra: Record<string, unknown> = {}) =>
  audit({
    kind: "runtime_error",
    action: "raised",
    actor: { type: "coordinator" },
    summary: "x",
    at,
    payload: {
      source: "http",
      where: "POST /inbound",
      name: "Error",
      message: "boom",
      fingerprint: "abc",
      ...extra,
    },
  });

const ticketRow = (
  at: string,
  action: string,
  payload: Record<string, unknown>,
  ids: { ticketId?: string; projectId?: string } = {},
) =>
  audit({
    kind: "ticket",
    action,
    actor: { type: "coordinator" },
    summary: "t",
    at,
    ticketId: ids.ticketId ?? "t1",
    projectId: ids.projectId ?? "p1",
    payload: { title: "Fix\nthe   thing", workerType: null, workerId: null, ...payload },
  });

describe("auditRuntimeError", () => {
  it("masks secrets, groups numbers together, keeps one row an hour, and never fails", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* auditRuntimeError({
          source: "health_sweep",
          where: "health sweep",
          error: new Error(
            "failed for 17 with sekret-value-123456 and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          ),
          secrets: ["sekret-value-123456"],
        });
        const again = yield* auditRuntimeError({
          source: "health_sweep",
          where: "health sweep",
          error: new Error(
            "failed for 99 with sekret-value-123456 and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          ),
          secrets: ["sekret-value-123456"],
        });
        const text = yield* auditRuntimeError({
          source: "channel_digest",
          where: "channel digest",
          error: "plain text",
        });
        const page = yield* incidentReport({ hours: 1 });
        return { first, again, text, page };
      }),
    );
    expect(result.first).toBe(true);
    // Same place, same message once numbers and secrets are ignored: logged once this hour.
    expect(result.again).toBe(false);
    expect(result.text).toBe(true);
    expect(result.page.markdown).toContain("2 distinct error(s)");
    expect(result.page.markdown).not.toContain("sekret-value-123456");
    expect(result.page.markdown).not.toContain("ghp_abc");
    expect(result.page.markdown).toContain("NonError");
  });
});

describe("auditRuntimeError size", () => {
  it("clips a long message and stack", async () => {
    const markdown = await run(
      Effect.gen(function* () {
        const error = new Error("m".repeat(900));
        error.stack = `Error\n${"at x\n".repeat(2000)}`;
        yield* auditRuntimeError({ source: "http", where: "GET /big", error });
        return (yield* incidentReport({ hours: 1 })).markdown;
      }),
    );
    expect(markdown).toContain(`${"m".repeat(499)}…`);
    expect(markdown).not.toContain("m".repeat(500));
  });
});

describe("incidentReport", () => {
  it("lists each kind of trouble in the window and nothing older", async () => {
    const { markdown, filename } = await run(
      Effect.gen(function* () {
        yield* errorRow(hoursAgo(5), { stack: "Error: boom\n  at a ```fence``` b" });
        yield* errorRow(hoursAgo(2));
        yield* errorRow(hoursAgo(3));
        yield* errorRow(hoursAgo(1), { fingerprint: "other", where: "POST /x", message: "y" });
        yield* errorRow(hoursAgo(30), { fingerprint: "old" });
        yield* ticketRow(hoursAgo(1), "status_changed", {
          status: "failed",
          error: "worker died",
          workerId: "w1",
        });
        yield* ticketRow(hoursAgo(1), "status_changed", {
          status: "blocked",
          reason: "needs a token",
        });
        yield* ticketRow(hoursAgo(1), "status_changed", { status: "blocked" });
        yield* ticketRow(hoursAgo(1), "status_changed", { status: "completed" });
        yield* ticketRow(hoursAgo(1), "created", { status: "failed" });
        yield* audit({
          kind: "worker",
          action: "went_offline",
          actor: { type: "coordinator" },
          summary: "Laptop went offline",
          at: hoursAgo(2),
          workerId: "w1",
          payload: {},
        });
        yield* audit({
          kind: "worker",
          action: "registered",
          actor: { type: "coordinator" },
          summary: "Laptop registered",
          at: hoursAgo(2),
          payload: {},
        });
        yield* audit({
          kind: "digest_event",
          action: "failed",
          actor: { type: "coordinator" },
          summary: "Digest failed: model down",
          at: hoursAgo(1),
          projectId: "p1",
          payload: {},
        });
        yield* audit({
          kind: "digest_event",
          action: "digested",
          actor: { type: "coordinator" },
          summary: "ok",
          at: hoursAgo(1),
          projectId: "p1",
          payload: {},
        });
        yield* audit({
          kind: "inbound_event",
          action: "classify_failed",
          actor: { type: "person" },
          summary: "classifier failed: timeout",
          at: hoursAgo(1),
          projectId: "p1",
          payload: {},
        });
        return yield* incidentReport({ hours: 24 });
      }),
    );
    expect(filename).toBe("incident-report-20261124-1200.md");
    expect(markdown).toContain("Window: last 24 hour(s)");
    expect(markdown).toContain("2 distinct error(s), 3 failed or blocked ticket event(s)");
    expect(markdown).toContain("Hours with this error: 3");
    expect(markdown).toContain("at a '''fence''' b");
    expect(markdown).not.toContain("`old`");
    expect(markdown).toContain('"Fix the thing" → failed: worker died (worker `w1`)');
    expect(markdown).toContain("→ blocked: needs a token");
    expect(markdown).toContain("1 worker outage(s), 1 digest failure(s), 1 classifier failure(s)");
    expect(markdown).toContain("Laptop went offline");
    expect(markdown).toContain("digest: Digest failed: model down");
    expect(markdown).toContain("classifier: classifier failed: timeout");
    expect(markdown).not.toContain("Laptop registered");
  });

  it("is scoped to a project, clamps the window, and reads past one page", async () => {
    const out = await run(
      Effect.gen(function* () {
        for (let i = 0; i < 205; i++) {
          yield* audit({
            kind: "runtime_error",
            action: "raised",
            actor: { type: "coordinator" },
            summary: "x",
            at: hoursAgo(1),
            projectId: "p1",
            payload: {
              source: "http",
              where: `GET /r${i}`,
              name: "Error",
              message: "m",
              fingerprint: `f${i}`,
            },
          });
        }
        yield* errorRow(hoursAgo(1), { fingerprint: "org-only" });
        const scoped = yield* incidentReport({ projectId: "p1", hours: 100000 });
        const small = yield* incidentReport({ hours: 0 });
        const defaults = yield* incidentReport();
        const missing = yield* Effect.flip(incidentReport({ projectId: "nope" }));
        return { scoped, small, defaults, missing };
      }),
    );
    expect(out.scoped.markdown).toContain("Window: last 336 hour(s)");
    expect(out.scoped.markdown).toContain("Scope: project p1");
    expect(out.scoped.markdown).toContain("205 distinct error(s)");
    expect(out.small.markdown).toContain("Window: last 1 hour(s)");
    expect(out.small.markdown).toContain("Scope: all projects");
    expect(out.defaults.markdown).toContain("Window: last 24 hour(s)");
    expect(out.missing._tag).toBe("ProjectNotFound");
  });
});

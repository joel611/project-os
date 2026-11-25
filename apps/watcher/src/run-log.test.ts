import type { RunUpload } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createRunRecorder,
  type PostResult,
  type RunLogIo,
  resendSpooled,
  runsUrl,
} from "./run-log.ts";

const AT = "2026-11-04T00:00:00.000Z";

const makeIo = (answer: (upload: RunUpload, call: number) => PostResult | "offline") => {
  const posted: RunUpload[] = [];
  const files = new Map<string, string>();
  const io: RunLogIo = {
    post: async (_url, _secret, upload) => {
      posted.push(upload);
      const result = answer(upload, posted.length);
      if (result === "offline") throw new Error("offline");
      return result;
    },
    spool: {
      write: (name, contents) => void files.set(name, contents),
      list: () => [...files].map(([name, contents]) => ({ name, contents })),
      remove: (name) => void files.delete(name),
    },
    newRunId: () => "run-00000001",
    now: () => new Date(AT),
    secrets: ["env-secret-value"],
    flushEveryMs: 3_600_000,
    sleep: async () => {},
    terminal: { out: () => {}, err: () => {} },
  };
  return { io, posted, files };
};

const recorder = (io: RunLogIo, model?: string) =>
  createRunRecorder({
    io,
    url: "http://c/tickets/t1/runs",
    secret: "device-secret-1",
    agent: "claude",
    ...(model && { model }),
  });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const out = (text: string) => ({ at: AT, type: "output" as const, text });

describe("runsUrl", () => {
  it("sits next to the MCP endpoint", () => {
    expect(runsUrl("http://c:8080/mcp", "t 1")).toBe("http://c:8080/tickets/t%201/runs");
  });
});

describe("createRunRecorder", () => {
  it("masks the device secret and the environment's secrets, then sends events with the exit", async () => {
    const { io, posted } = makeIo((u) => ({ ok: true, nextSeq: u.seq + 1 }));
    const r = recorder(io);
    r.push(out("using device-secret-1 and env-secret-value"));
    await r.finish(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ runId: "run-00000001", seq: 0, finished: { exitCode: 0 } });
    expect(posted[0]!.events[0]!.text).toBe("using [REDACTED] and [REDACTED]");
  });

  it("splits a large backlog into chunks and puts the exit on the last", async () => {
    const { io, posted } = makeIo((u) => ({ ok: true, nextSeq: u.seq + 1 }));
    const r = recorder(io);
    for (let i = 0; i < 1_200; i++) r.push(out(`line ${i}`));
    await r.finish(3);
    const sent = posted.filter((p) => p.events.length > 0);
    expect(sent.reduce((n, p) => n + p.events.length, 0)).toBe(1_200);
    expect(sent.map((p) => p.seq)).toEqual([...sent.keys()]);
    expect(posted.filter((p) => p.finished)).toHaveLength(1);
    expect(posted.at(-1)!.finished).toEqual({ exitCode: 3 });
  });

  it("retries the same chunk after a failed upload", async () => {
    const { io, posted } = makeIo((u, call) =>
      call === 1 ? "offline" : { ok: true, nextSeq: u.seq + 1 },
    );
    const r = recorder(io);
    r.push(out("a"));
    await r.finish(0);
    expect(posted.map((p) => [p.seq, p.events.map((e) => e.text)])).toEqual([
      [0, ["a"]],
      [0, ["a"]],
    ]);
  });

  it("saves the rest to the spool when the Coordinator stays unreachable", async () => {
    const { io, files } = makeIo(() => "offline");
    const r = recorder(io);
    r.push(out("a"));
    await r.finish(1);
    expect([...files.keys()]).toEqual(["run-00000001.json"]);
    const [saved] = JSON.parse(files.get("run-00000001.json")!);
    expect(saved.upload).toMatchObject({ seq: 0, finished: { exitCode: 1 } });
  });

  it("drops the log, without spooling, when the Coordinator refuses it", async () => {
    const { io, files } = makeIo(() => ({ ok: false, status: 403 }));
    const r = recorder(io);
    r.push(out("a"));
    await r.finish(0);
    expect(files.size).toBe(0);
  });
});

describe("createRunRecorder, harder cases", () => {
  it("sends a chunk early once enough events pile up, then the exit on its own", async () => {
    const { io, posted } = makeIo((u) => ({ ok: true, nextSeq: u.seq + 1 }));
    const r = recorder(io, "opus");
    for (let i = 0; i < 100; i++) r.push(out(`line ${i}`));
    await tick();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ model: "opus" });
    await r.finish(0);
    expect(posted[1]).toMatchObject({ seq: 1, events: [], finished: { exitCode: 0 } });
  });

  it("sends on the timer while the session runs", async () => {
    const { io, posted } = makeIo((u) => ({ ok: true, nextSeq: u.seq + 1 }));
    const r = recorder({ ...io, flushEveryMs: 5 });
    r.push(out("a"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(posted.length).toBeGreaterThan(0);
    await r.finish(0);
  });

  it("takes a chunk the Coordinator already has as sent", async () => {
    const { io, posted } = makeIo((u, call) =>
      call === 1
        ? { ok: false, status: 409, expected: u.seq + 1 }
        : { ok: true, nextSeq: u.seq + 1 },
    );
    const r = recorder(io);
    r.push(out("a"));
    r.push(out("b"));
    await r.finish(0);
    expect(posted.map((p) => [p.seq, p.events.length])).toEqual([
      [0, 2],
      [1, 0],
    ]);
  });

  it("gives up on a run whose numbering is out of step, without spooling", async () => {
    const { io, posted, files } = makeIo(() => ({ ok: false, status: 409, expected: 7 }));
    const r = recorder(io);
    r.push(out("a"));
    await r.finish(0);
    r.push(out("ignored"));
    expect(posted).toHaveLength(1);
    expect(files.size).toBe(0);
  });

  it("retries on a 409 that names the chunk it is already on, or a server error", async () => {
    const { io, posted, files } = makeIo((u) => ({
      ok: false,
      status: u.seq === 0 ? 409 : 500,
      expected: 0,
    }));
    const r = recorder(io);
    r.push(out("a"));
    await r.finish(0);
    expect(posted.length).toBe(3);
    expect(files.size).toBe(1);
  });

  it("refuses with each permanent status", async () => {
    for (const status of [400, 403, 404]) {
      const { io, files } = makeIo(() => ({ ok: false, status }));
      const r = recorder(io);
      r.push(out("a"));
      await r.finish(0);
      expect(files.size).toBe(0);
    }
  });

  it("spools a big backlog in chunks, with the model and the exit on the last", async () => {
    const { io, files } = makeIo(() => "offline");
    const r = recorder(io, "opus");
    for (let i = 0; i < 1_200; i++) r.push(out(`line ${i}`));
    await r.finish(5);
    const saved = JSON.parse(files.get("run-00000001.json")!) as Array<{ upload: RunUpload }>;
    expect(saved.map((s) => s.upload.seq)).toEqual([0, 1, 2]);
    expect(saved.map((s) => s.upload.finished)).toEqual([undefined, undefined, { exitCode: 5 }]);
    expect(saved[0]!.upload.model).toBe("opus");
  });

  it("carries on when the spool itself can't be written", async () => {
    const { io } = makeIo(() => "offline");
    const broken: RunLogIo = {
      ...io,
      spool: {
        ...io.spool,
        write: () => {
          throw new Error("disk full");
        },
      },
    };
    const r = recorder(broken);
    r.push(out("a"));
    await expect(r.finish(0)).resolves.toBeUndefined();
  });
});

describe("resendSpooled, harder cases", () => {
  const spooled = (...uploads: Array<Partial<RunUpload>>) =>
    JSON.stringify(
      uploads.map((u) => ({
        url: "http://c/x",
        upload: { runId: "r", seq: 0, agent: "claude", events: [], ...u },
      })),
    );

  it("moves past a chunk the Coordinator has or will never take, and stops at one it can't reach", async () => {
    const answers: Array<PostResult | "offline"> = [
      { ok: false, status: 409 },
      { ok: false, status: 404 },
      { ok: false, status: 500 },
      { ok: true, nextSeq: 9 },
    ];
    const { io, files } = makeIo(() => answers.shift()!);
    io.spool.write("a.json", spooled({ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }));
    expect(await resendSpooled(io, "s")).toBe(0);
    expect(files.size).toBe(1);
    // Only three were tried; the fourth waits behind the one that failed.
    expect(answers).toHaveLength(1);
  });
});

describe("resendSpooled", () => {
  it("delivers saved uploads and removes them, keeping the ones that still fail", async () => {
    const online = makeIo((u) => ({ ok: true, nextSeq: u.seq + 1 }));
    const down = makeIo(() => "offline");
    const upload = {
      url: "http://c/x",
      upload: { runId: "r", seq: 0, agent: "claude", events: [] },
    };
    for (const { io } of [online, down]) io.spool.write("a.json", JSON.stringify([upload]));
    online.io.spool.write("bad.json", "not json");

    expect(await resendSpooled(online.io, "s")).toBe(1);
    expect(online.files.size).toBe(0);
    expect(await resendSpooled(down.io, "s")).toBe(0);
    expect(down.files.size).toBe(1);
  });
});

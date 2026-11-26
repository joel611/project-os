import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { collectLogger } from "./logger.ts";
import { type SessionLogFile, sessionLogFiles, sessionLogSink } from "./session-log.ts";

const dir = mkdtempSync(join(tmpdir(), "session-log-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const event = (text: string) => ({ at: "2026-11-26T00:00:00.000Z", type: "output" as const, text });

describe("session log files", () => {
  it("appends each event as a JSON line, in a folder and file only this user can read", async () => {
    const open = sessionLogFiles(join(dir, "sessions"));
    const sink = sessionLogSink(() => open("t1", "a.log"), collectLogger([]));
    sink.push(event("one"));
    sink.push(event("two\nlines"));
    await sink.finish(0);
    const file = join(dir, "sessions", "t1", "a.log");
    expect(
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([event("one"), event("two\nlines")]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sessions", "t1")).mode & 0o777).toBe(0o700);
    // Pushed after the end, nothing more is written.
    sink.push(event("late"));
    expect(readFileSync(file, "utf8")).not.toContain("late");
  });

  it("keeps the session going when the file can't be opened", () => {
    writeFileSync(join(dir, "taken"), "a file where the folder should be");
    const logs: string[] = [];
    const sink = sessionLogSink(() => sessionLogFiles(dir)("taken", "a.log"), collectLogger(logs));
    expect(() => sink.push(event("one"))).not.toThrow();
    expect(logs).toEqual([expect.stringMatching(/^session log: could not open it: /)]);
  });

  it("gives up once a write fails, and never throws", async () => {
    const calls: string[] = [];
    const broken = (closeFails: boolean): SessionLogFile => ({
      write: (text) => {
        calls.push(`write ${text.length}`);
        throw new Error("disk full");
      },
      close: () => {
        calls.push("close");
        if (closeFails) throw new Error("bad fd");
      },
    });
    for (const closeFails of [false, true]) {
      calls.length = 0;
      const logs: string[] = [];
      const sink = sessionLogSink(() => broken(closeFails), collectLogger(logs));
      sink.push(event("one"));
      sink.push(event("two"));
      await expect(sink.finish(0)).resolves.toBeUndefined();
      expect(calls.filter((c) => c.startsWith("write"))).toHaveLength(1);
      expect(logs).toEqual(["session log: could not write it: disk full"]);
    }
  });

  it("logs a file that won't close", async () => {
    const logs: string[] = [];
    const sink = sessionLogSink(
      () => ({
        write: () => {},
        close: () => {
          throw new Error("bad fd");
        },
      }),
      collectLogger(logs),
    );
    await expect(sink.finish(0)).resolves.toBeUndefined();
    expect(logs).toEqual(["session log: could not close it: bad fd"]);
  });
});

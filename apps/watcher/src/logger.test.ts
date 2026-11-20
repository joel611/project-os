import { describe, expect, it } from "vite-plus/test";
import { collectLogger, createLogger, errorMessage, silentLogger } from "./logger.ts";

const capture = (run: () => void): string[] => {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return lines;
};

describe("createLogger", () => {
  it("writes JSON lines with an ISO time and the fields", () => {
    const [line] = capture(() =>
      createLogger({ verbose: false, pretty: false }).info("hello", { ticketId: "t1" }),
    );
    const entry = JSON.parse(line!);
    expect(entry).toMatchObject({ msg: "hello", ticketId: "t1" });
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("hides debug unless verbose", () => {
    const quiet = capture(() => createLogger({ verbose: false, pretty: false }).debug("x"));
    const loud = capture(() => createLogger({ verbose: true, pretty: false }).debug("x"));
    expect(quiet).toEqual([]);
    expect(loud).toHaveLength(1);
  });

  it("logs warn and error at their own levels", () => {
    const lines = capture(() => {
      const logger = createLogger({ verbose: false, pretty: false });
      logger.warn("w");
      logger.error("e", { code: 1 });
    });
    expect(lines.map((l) => JSON.parse(l).level)).toEqual([40, 50]);
  });

  it("prints a readable timestamp for a terminal", () => {
    const text = capture(() => createLogger({ verbose: false, pretty: true }).info("hello")).join(
      "\n",
    );
    expect(text).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/);
    expect(text).toContain("hello");
  });

  it("picks pretty output from whether stdout is a terminal", () => {
    const original = process.stdout.isTTY;
    process.stdout.isTTY = false;
    try {
      const [line] = capture(() => createLogger({ verbose: false }).info("plain"));
      expect(JSON.parse(line!).msg).toBe("plain");
    } finally {
      process.stdout.isTTY = original;
    }
  });
});

describe("test loggers", () => {
  it("collectLogger keeps info, warn and error but not debug", () => {
    const sink: string[] = [];
    const logger = collectLogger(sink);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(sink).toEqual(["i", "w", "e"]);
  });

  it("silentLogger drops everything", () => {
    expect(() => {
      silentLogger.debug("d");
      silentLogger.info("i");
      silentLogger.warn("w");
      silentLogger.error("e");
    }).not.toThrow();
  });

  it("errorMessage reads an Error or stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("weird")).toBe("weird");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { createLogger } from "./logger.ts";

const capture = async (run: () => void): Promise<string[]> => {
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
  it("writes JSON lines with an ISO time and the fields", async () => {
    const [line] = await capture(() =>
      createLogger({ verbose: false, pretty: false }).info("hello", {
        ticketId: "t1",
      }),
    );
    const entry = JSON.parse(line!);
    expect(entry).toMatchObject({ msg: "hello", ticketId: "t1" });
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("hides debug unless verbose", async () => {
    const quiet = await capture(() => createLogger({ verbose: false, pretty: false }).debug("x"));
    const loud = await capture(() => createLogger({ verbose: true, pretty: false }).debug("x"));
    expect(quiet).toEqual([]);
    expect(loud).toHaveLength(1);
  });
});

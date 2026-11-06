import { describe, expect, it } from "vite-plus/test";
import { parseArgs } from "./cli.ts";

describe("parseArgs", () => {
  it("runs with no arguments", () => {
    expect(parseArgs([])).toEqual({ kind: "run" });
  });

  it("parses register with its code, server and name", () => {
    expect(parseArgs(["register", "abc", "--server", "https://c", "--name", "my laptop"])).toEqual({
      kind: "register",
      token: "abc",
      server: "https://c",
      name: "my laptop",
    });
    expect(parseArgs(["register", "--server", "https://c", "abc"])).toMatchObject({ token: "abc" });
  });

  it("explains what's wrong", () => {
    expect(() => parseArgs(["register"])).toThrow(/needs the code/);
    expect(() => parseArgs(["register", "a", "--server"])).toThrow(/--server needs a value/);
    expect(() => parseArgs(["register", "a", "b"])).toThrow(/Unexpected argument "b"/);
    expect(() => parseArgs(["start"])).toThrow(/Unknown command "start"/);
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
  });
});

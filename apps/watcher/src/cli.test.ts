import { describe, expect, it } from "vite-plus/test";
import { parseArgs, USAGE } from "./cli.ts";

describe("parseArgs", () => {
  it("runs with no arguments", () => {
    expect(parseArgs([])).toEqual({ kind: "run", verbose: false });
    expect(parseArgs(["--verbose"])).toEqual({ kind: "run", verbose: true });
    expect(parseArgs(["-v"])).toEqual({ kind: "run", verbose: true });
  });

  it("parses register with its code, server and name", () => {
    expect(parseArgs(["register", "abc", "--server", "https://c", "--name", "my laptop"])).toEqual({
      kind: "register",
      verbose: false,
      token: "abc",
      server: "https://c",
      name: "my laptop",
    });
    expect(parseArgs(["register", "--server", "https://c", "abc"])).toMatchObject({ token: "abc" });
  });

  it("parses register's agent and model, and rejects an unknown agent", () => {
    expect(
      parseArgs([
        "register",
        "abc",
        "--agent",
        "codex",
        "--model",
        "gpt-5",
        "--server",
        "https://c",
      ]),
    ).toEqual({
      kind: "register",
      verbose: false,
      token: "abc",
      server: "https://c",
      agent: "codex",
      model: "gpt-5",
    });
    expect(() => parseArgs(["register", "abc", "--agent", "gemini"])).toThrow(
      /--agent must be one of claude, pi, codex/,
    );
  });

  it("parses uninstall, asking first unless --yes", () => {
    expect(parseArgs(["uninstall"])).toEqual({ kind: "uninstall", yes: false });
    expect(parseArgs(["uninstall", "--yes"])).toEqual({ kind: "uninstall", yes: true });
    expect(parseArgs(["uninstall", "-y"])).toEqual({ kind: "uninstall", yes: true });
    expect(() => parseArgs(["uninstall", "--all"])).toThrow(/Unexpected argument "--all"/);
  });

  it("documents every command in --help", () => {
    for (const word of [
      "register",
      "uninstall",
      "--help",
      "--agent",
      "--model",
      "--yes",
      "--verbose",
    ]) {
      expect(USAGE).toContain(word);
    }
  });

  it("explains what's wrong", () => {
    expect(() => parseArgs(["register"])).toThrow(/needs the code/);
    expect(() => parseArgs(["register", "a", "--server"])).toThrow(/--server needs a value/);
    expect(() => parseArgs(["register", "a", "b"])).toThrow(/Unexpected argument "b"/);
    expect(() => parseArgs(["start"])).toThrow(/Unknown command "start"/);
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
  });
});

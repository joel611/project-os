import { describe, expect, it } from "vite-plus/test";
import { PACKAGE_UNINSTALL, type UninstallIo, uninstallWatcher } from "./uninstall.ts";

const CONFIG = "/home/me/.config/project-os";
const PI = "/home/me/.pi/agent/mcp.json";

const harness = (
  files: Record<string, string> = {},
  over: Partial<UninstallIo> & { exit?: number } = {},
) => {
  const events: string[] = [];
  const logs: string[] = [];
  const store = { ...files };
  const io: UninstallIo = {
    configDir: CONFIG,
    home: "/home/me",
    ownPid: 10,
    readFile: (path) => store[path],
    writeFile: (path, contents) => {
      store[path] = contents;
      events.push(`write ${path}`);
    },
    remove: (path) => {
      delete store[path];
      events.push(`remove ${path}`);
    },
    removeDirIfEmpty: (dir) => events.push(`rmdir ${dir}`),
    watcherPids: async () => [10, 11, 12],
    kill: (pid) => events.push(`kill ${pid}`),
    run: async (cmd) => {
      events.push(`run ${cmd.join(" ")}`);
      return over.exit ?? 0;
    },
    confirm: async () => true,
    log: (message) => logs.push(message),
    ...over,
  };
  return { io, events, logs, store };
};

describe("uninstallWatcher", () => {
  it("stops other watchers (not itself), removes the package, state and Pi entry, in that order", async () => {
    const { io, events, store, logs } = harness({
      [`${CONFIG}/watcher.json`]: "{}",
      [`${CONFIG}/mcp.json`]: "{}",
      [PI]: JSON.stringify({
        theme: "dark",
        mcpServers: { mine: { url: "u" }, "project-os": { url: "c" } },
      }),
    });
    expect(await uninstallWatcher(io, { yes: true })).toBe(0);
    expect(events).toEqual([
      "kill 11",
      "kill 12",
      `write ${PI}`,
      `run ${PACKAGE_UNINSTALL.join(" ")}`,
      `remove ${CONFIG}/watcher.json`,
      `remove ${CONFIG}/mcp.json`,
      `rmdir ${CONFIG}`,
    ]);
    expect(JSON.parse(store[PI]!)).toEqual({ theme: "dark", mcpServers: { mine: { url: "u" } } });
    expect(logs.at(-1)).toContain("/unregister-worker");
  });

  it("leaves Pi's file alone when it has no entry, or doesn't exist", async () => {
    const withoutEntry = harness({ [PI]: '{"mcpServers":{"mine":{}}}' });
    await uninstallWatcher(withoutEntry.io, { yes: true });
    expect(withoutEntry.events.some((e) => e.startsWith("write"))).toBe(false);

    const noFile = harness();
    expect(await uninstallWatcher(noFile.io, { yes: true })).toBe(0);
    expect(noFile.events.some((e) => e.startsWith("write"))).toBe(false);

    const noServers = harness({ [PI]: '{"theme":"dark"}' });
    await uninstallWatcher(noServers.io, { yes: true });
    expect(noServers.events.some((e) => e.startsWith("write"))).toBe(false);
  });

  it("tells the person what it will do and asks first, doing nothing on no", async () => {
    const { io, events, logs } = harness({}, { confirm: async () => false });
    expect(await uninstallWatcher(io, { yes: false })).toBe(1);
    expect(events).toEqual([]);
    expect(logs[0]).toBe("This will:");
    expect(logs.join("\n")).toContain("bun remove -g @project-os/watcher");
    expect(logs.at(-1)).toBe("Cancelled.");
  });

  it("goes ahead on yes without --yes", async () => {
    const { io, events } = harness();
    expect(await uninstallWatcher(io, { yes: false })).toBe(0);
    expect(events).toContain(`remove ${CONFIG}/watcher.json`);
  });

  it("warns, but still removes the saved registration, when the package removal fails", async () => {
    const { io, events, logs } = harness({}, { exit: 1 });
    expect(await uninstallWatcher(io, { yes: true })).toBe(0);
    expect(logs.join("\n")).toContain("failed; remove the package by hand");
    expect(events).toContain(`remove ${CONFIG}/watcher.json`);
  });
});

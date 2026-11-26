import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { saveCredentials } from "../../watcher/src/credentials.ts";

const entry = fileURLToPath(new URL("../../watcher/src/main.bun.ts", import.meta.url));

it("logs the Watcher banner and effective settings without logging the worker secret", async () => {
  const home = mkdtempSync(join(tmpdir(), "watcher-startup-"));
  const device = {
    server: "http://127.0.0.1:1/coordinator",
    workerId: "shared-box",
    name: "shared-box",
    secret: "fake-worker-secret",
    agent: "pi",
    model: "saved-model",
  } as const;
  try {
    saveCredentials(join(home, "watcher.json"), device);

    for (const [agent, model, acp] of [
      ["pi", "override-model", "on"],
      ["claude", "", "off"],
    ] as const) {
      const child = spawn(process.execPath, ["--no-install", entry], {
        env: {
          PATH: process.env.PATH,
          PROJECT_OS_WATCHER_HOME: home,
          WATCHER_AGENT: agent,
          WATCHER_PI_ACP: "1",
          WATCHER_MODEL: model,
          WATCHER_RUN_LOG: "0",
        },
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const lines = createInterface({ input: child.stdout });
      try {
        const line = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("No Watcher startup log")), 10_000);
          lines.once("line", (line) => {
            clearTimeout(timeout);
            resolve(line);
          });
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`Watcher exited before logging startup (${code})`));
          });
        });
        const { msg, ...config } = JSON.parse(line);
        expect(msg).toMatch(/____.*___  ____\n/);
        expect(config).toMatchObject({
          coordinator: device.server,
          agent,
          acp,
          model: model || "agent default",
          workerId: device.workerId,
        });
        expect(line).not.toContain(device.secret);
      } finally {
        lines.close();
        child.kill();
        await closed;
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 25_000);

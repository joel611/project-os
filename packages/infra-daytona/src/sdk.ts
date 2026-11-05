import { Daytona } from "@daytona/sdk";
import type { SandboxRunner } from "./launcher.ts";

const SESSION_ID = "worker";
const POLL_MS = 5_000;

/** Auto-delete minutes after the last activity: a safety net if `delete` below never runs. */
const AUTO_STOP_MINUTES = 5;

export const daytonaSandboxRunner = (
  options: { readonly apiKey: string; readonly apiUrl?: string; readonly snapshot?: string },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): SandboxRunner => {
  const daytona = new Daytona({
    apiKey: options.apiKey,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
  });
  return {
    run: async ({ env, command, timeoutSeconds }) => {
      const sandbox = await daytona.create({
        envVars: { ...env },
        ephemeral: true,
        autoStopInterval: AUTO_STOP_MINUTES,
        ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
      });
      try {
        await sandbox.process.createSession(SESSION_ID);
        const started = await sandbox.process.executeSessionCommand(SESSION_ID, {
          command,
          runAsync: true,
        });
        const cmdId = started.cmdId;
        if (cmdId === undefined) throw new Error("Daytona returned no command id");
        const deadline = Date.now() + timeoutSeconds * 1000;
        for (;;) {
          const status = await sandbox.process.getSessionCommand(SESSION_ID, cmdId);
          if (status.exitCode !== undefined && status.exitCode !== null) {
            const logs = await sandbox.process.getSessionCommandLogs(SESSION_ID, cmdId);
            return { exitCode: status.exitCode, output: logs.output ?? logs.stderr ?? "" };
          }
          if (Date.now() > deadline) throw new Error(`session exceeded ${timeoutSeconds}s`);
          await sleep(POLL_MS);
        }
      } finally {
        await sandbox.delete().catch(() => undefined);
      }
    },
  };
};

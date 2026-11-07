import type { SandboxRunner } from "@project-os/sandbox-core";

/** The slice of `@daytona/sdk` the runner uses, so tests can fake it. */
export interface DaytonaLike {
  readonly create: (params: {
    readonly envVars: Record<string, string>;
    readonly ephemeral: boolean;
    readonly autoStopInterval: number;
    readonly snapshot?: string;
  }) => Promise<SandboxLike>;
}

export interface SandboxLike {
  readonly process: {
    readonly createSession: (sessionId: string) => Promise<void>;
    readonly executeSessionCommand: (
      sessionId: string,
      req: { readonly command: string; readonly runAsync: boolean },
    ) => Promise<{ readonly cmdId?: string }>;
    readonly getSessionCommand: (
      sessionId: string,
      commandId: string,
    ) => Promise<{ readonly exitCode?: number | null }>;
    readonly getSessionCommandLogs: (
      sessionId: string,
      commandId: string,
    ) => Promise<{ readonly output?: string }>;
  };
  readonly delete: () => Promise<void>;
}

const SESSION_ID = "worker";
const POLL_MS = 5_000;

/** Minutes of inactivity before Daytona reclaims the sandbox: a net if `delete` never runs. */
const AUTO_STOP_MINUTES = 5;

export const makeSandboxRunner = (
  daytona: DaytonaLike,
  options: {
    readonly snapshot?: string;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
  },
): SandboxRunner => {
  const { sleep, now } = options;
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
        const deadline = now() + timeoutSeconds * 1000;
        for (;;) {
          const status = await sandbox.process.getSessionCommand(SESSION_ID, cmdId);
          if (typeof status.exitCode === "number") {
            const logs = await sandbox.process.getSessionCommandLogs(SESSION_ID, cmdId);
            return { exitCode: status.exitCode, output: logs.output ?? "" };
          }
          if (now() > deadline) throw new Error(`session exceeded ${timeoutSeconds}s`);
          await sleep(POLL_MS);
        }
      } finally {
        await sandbox.delete().catch(() => undefined);
      }
    },
  };
};

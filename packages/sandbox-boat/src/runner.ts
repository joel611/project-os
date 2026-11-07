import type { SandboxRunner } from "@project-os/infra-sandbox";

export const BOAT_SIZES = ["small", "default", "large", "xlarge"] as const;
export type BoatSize = (typeof BOAT_SIZES)[number];

/** The slice of `@boatdev/sdk` the runner uses, so tests can fake it. */
export interface BoatLike {
  readonly create: (params: {
    readonly ttlSeconds: number;
    readonly env: Record<string, string>;
    readonly type?: BoatSize;
  }) => Promise<{ readonly sandbox: { readonly id: string } }>;
  readonly waitUntilReady: (sandboxId: string) => Promise<unknown>;
  /** Starts the command detached; resolves to its process id. */
  readonly startCommand: (
    sandboxId: string,
    command: string,
  ) => Promise<{ readonly processId: number }>;
  readonly commandStatus: (
    sandboxId: string,
    processId: number,
  ) => Promise<{
    readonly status: string;
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  /** Deletes the sandbox and its disk (a plain `stop` would keep, and bill for, the disk). */
  readonly deleteSandbox: (sandboxId: string) => Promise<unknown>;
}

export const POLL_MS = 5_000;
/** boat.dev stops the sandbox after its TTL, a net if `deleteSandbox` never runs. */
const TTL_GRACE_SECONDS = 5 * 60;
const OUTPUT_TAIL = 4_000;

export const makeBoatRunner = (
  boat: BoatLike,
  options: {
    /** Sandbox size. Unset: the account default. */
    readonly size?: BoatSize;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
  },
): SandboxRunner => ({
  run: async ({ env, command, timeoutSeconds }) => {
    const created = await boat.create({
      ttlSeconds: timeoutSeconds + TTL_GRACE_SECONDS,
      env: { ...env },
      ...(options.size === undefined ? {} : { type: options.size }),
    });
    const sandboxId = created.sandbox.id;
    try {
      await boat.waitUntilReady(sandboxId);
      const deadline = options.now() + timeoutSeconds * 1000;
      const { processId } = await boat.startCommand(sandboxId, command);
      for (;;) {
        const status = await boat.commandStatus(sandboxId, processId);
        if (status.status !== "running") {
          // `lost`: boat.dev no longer knows the process, so there is no exit code to report.
          return {
            exitCode: status.exitCode ?? 1,
            output: `${status.stdout}${status.stderr}`.slice(-OUTPUT_TAIL),
          };
        }
        if (options.now() > deadline) throw new Error(`session exceeded ${timeoutSeconds}s`);
        await options.sleep(POLL_MS);
      }
    } finally {
      await boat.deleteSandbox(sandboxId).catch(() => undefined);
    }
  },
});

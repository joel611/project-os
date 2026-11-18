import type { SandboxRunner } from "@project-os/sandbox-core";

/**
 * A sandbox session outlives the request that started it, so `waitUntil` keeps the Worker alive
 * for it. Workers cap that time at 30 s after the response; see "Known gaps" in
 * apps/site/guide/deployment.md.
 */
export const heldOpen = (
  runner: SandboxRunner,
  waitUntil: (promise: Promise<unknown>) => void,
): SandboxRunner => ({
  run: (input) => {
    const session = runner.run(input);
    waitUntil(session.catch(() => undefined));
    return session;
  },
});

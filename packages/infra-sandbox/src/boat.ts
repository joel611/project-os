import type { SandboxRunner } from "./launcher.ts";

/**
 * boat.dev: planned, not built. The name is as requested; the exact product and its API are
 * still to be confirmed, so this is only a placeholder that fails every run. The pool refuses
 * `boat` in WORKER_PROVIDERS until a real runner replaces this.
 */
export const BOAT_NOT_SUPPORTED = "boat.dev is a planned sandbox provider and is not supported yet";

export const boatSandboxRunner = (): SandboxRunner => ({
  run: () => Promise.reject(new Error(BOAT_NOT_SUPPORTED)),
});

import {
  SANDBOX_PROVIDERS,
  SANDBOX_WORKER_TYPES,
  SANDBOX_PROVIDER_OF,
  type SandboxProvider as ProviderName,
  type SandboxWorkerType,
} from "@project-os/contracts";
import type { SandboxProvider, SandboxRunner } from "./launcher.ts";

const WORKER_TYPE_OF = Object.fromEntries(
  SANDBOX_WORKER_TYPES.map((type) => [SANDBOX_PROVIDER_OF[type], type] as const),
) as Record<ProviderName, SandboxWorkerType>;

/**
 * Builds the sandbox pool from settings. `requested` is WORKER_PROVIDERS: a comma list in
 * preference order. Unset or blank, every configured provider joins, Daytona first. Naming a
 * provider that isn't configured or isn't known throws, so a
 * typo fails at startup instead of silently sending every ticket to the Watcher.
 */
export const resolvePool = (input: {
  readonly requested: string | undefined;
  /** Runners for the providers whose credentials are set. */
  readonly configured: Partial<Record<ProviderName, SandboxRunner>>;
  readonly maxConcurrent?: Partial<Record<ProviderName, number>>;
}): ReadonlyArray<SandboxProvider> => {
  const names = (input.requested ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  const order: ReadonlyArray<string> =
    names.length > 0 ? names : SANDBOX_PROVIDERS.filter((n) => input.configured[n] !== undefined);
  const seen = new Set<string>();
  const pool: SandboxProvider[] = [];
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!(SANDBOX_PROVIDERS as ReadonlyArray<string>).includes(name)) {
      throw new Error(
        `WORKER_PROVIDERS: unknown provider "${name}" (known: ${SANDBOX_PROVIDERS.join(", ")})`,
      );
    }
    const provider = name as ProviderName;
    const workerType = WORKER_TYPE_OF[provider];
    const runner = input.configured[provider];
    if (runner === undefined) {
      throw new Error(
        `WORKER_PROVIDERS names "${name}" but it isn't configured (see apps/site/workers/cloud-sandbox.md)`,
      );
    }
    const max = input.maxConcurrent?.[provider];
    pool.push({ workerType, runner, ...(max === undefined ? {} : { maxConcurrent: max }) });
  }
  return pool;
};

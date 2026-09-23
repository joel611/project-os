/**
 * `cloudflare:workers` only resolves inside the real Workers runtime.
 * Tests run `apps/api`'s Hono app directly under vitest/Node (see
 * `docs/adr/0001-plain-drizzle-d1-over-effect-sql-d1.md`), so this stub
 * stands in for it — aliased in `vitest.config.ts`.
 */
export class DurableObject {
  ctx: unknown;
  env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

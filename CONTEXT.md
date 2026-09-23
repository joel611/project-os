# project-os

Project-centric AI agent (see `docs/product-brief.md`) — PMs/Team Leads get cited answers across email, Drive, and (later) code without pinging engineers. Built on Cloudflare Workers + D1 + Drizzle + Better Auth + Effect v4 (see `docs/technical-architecture.md`).

## Language

**Db**: Effect `Context.Service` wrapping a plain `drizzle-orm/d1` instance over the Cloudflare D1 binding (`env.DB`). Built fresh per request, not a shared pool — D1's binding isn't a pooled resource the way `pg.Pool` is, so per-request construction is cheap and there's nothing to prove shared. Every Drizzle call is wrapped in `Effect.tryPromise` at the call site, not native Effect queries.

**Auth**: Effect `Context.Service` wrapping Better Auth's official `drizzleAdapter` over the same request's `Db` instance. Exposes session/sign-in/sign-up as Effects with a tagged error.

**Domain module**: the convention for anything DB-backed under `packages/core/src`: its own folder holding the service (`Context.Service`), a typed error (`Data.TaggedError`), and its own Drizzle schema, colocated rather than centralized. `libs/db` and `libs/auth` stay thin client/adapter wrappers — no schema of their own.
_Avoid_: package, feature, module (alone) — always "domain module" so it isn't confused with an npm workspace package.

**Task**: throwaway demo entity used to prove the Db/Auth/Effect wiring round-trips through D1 before any real domain module is built. Deliberately meaningless.
_Avoid_: To-do, ticket.

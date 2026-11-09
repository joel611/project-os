import { AgentRuntime, IdGenerator, Sidekick, UserConnections } from "@project-os/core";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  AgentRuntimePending,
  DEFAULT_ORG,
  IdGeneratorUuid,
  noopLauncher,
  SidekickPending,
  UserConnectionsUnavailable,
} from "./shared.ts";

// The inputs are never read by the placeholders.
const anything = undefined as never;

describe("placeholder ports", () => {
  it("the Sidekick fails with a SidekickError", async () => {
    const exit = await Effect.runPromiseExit(
      Sidekick.use((s) => s.answer(anything)).pipe(Effect.provide(SidekickPending)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("not wired");
  });

  it("the AgentRuntime dies until it is wired", async () => {
    const exit = await Effect.runPromiseExit(
      AgentRuntime.use((a) => a.respond(anything)).pipe(Effect.provide(AgentRuntimePending)),
    );
    expect(Exit.hasDies(exit)).toBe(true);
  });

  it("account linking is unavailable", async () => {
    const run = <A, E>(f: (c: typeof UserConnections.Service) => Effect.Effect<A, E>) =>
      Effect.runPromiseExit(
        UserConnections.use(f).pipe(Effect.provide(UserConnectionsUnavailable)),
      );

    expect(Exit.isFailure(await run((c) => c.connectUrl(anything, anything)))).toBe(true);
    expect(Exit.isFailure(await run((c) => c.accessToken(anything, anything)))).toBe(true);
    expect(
      await Effect.runPromise(
        UserConnections.use((c) => c.list(anything)).pipe(
          Effect.provide(UserConnectionsUnavailable),
        ),
      ),
    ).toEqual([]);
    expect(
      await Effect.runPromise(
        UserConnections.use((c) => c.disconnect(anything, anything)).pipe(
          Effect.provide(UserConnectionsUnavailable),
        ),
      ),
    ).toBe(false);
  });

  it("the no-op launcher has an empty pool and launches nothing", async () => {
    expect(await Effect.runPromise(noopLauncher.pool)).toEqual([]);
    await Effect.runPromise(noopLauncher.launch(anything));
  });

  it("ids are unique and the default org is fixed", async () => {
    const next = IdGenerator.use((g) => g.next).pipe(Effect.provide(IdGeneratorUuid));
    const [a, b] = [await Effect.runPromise(next), await Effect.runPromise(next)];
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect(DEFAULT_ORG.id).toBe("default-org");
  });
});

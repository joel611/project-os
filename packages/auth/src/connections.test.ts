import { Database } from "bun:sqlite";
import { migrationsFolder, schema } from "@project-os/db-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeConnections, type OAuthClientConfig } from "./connections.ts";

// The OAuth round trip runs in apps/e2e (connect-accounts) against a fake provider.
// These cover what happens without one: unconfigured providers and unknown people.

const client: OAuthClientConfig = { clientId: "id", clientSecret: "secret" };

const connectionsWith = (providers: { google?: OAuthClientConfig; github?: OAuthClientConfig }) => {
  const db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder });
  return makeConnections({
    db,
    baseURL: "http://localhost:8080",
    secret: "unit-test-secret-unit-test-secret",
    ...providers,
  }).service;
};

const nameless = { channelType: "discord" as const, id: "u1" };

describe("makeConnections", () => {
  it("refuses providers with no OAuth client", async () => {
    const service = connectionsWith({ google: client });
    const link = await Effect.runPromise(Effect.result(service.connectUrl(nameless, "github")));
    const token = await Effect.runPromise(Effect.result(service.accessToken(nameless, "github")));
    expect(link).toMatchObject({ failure: { _tag: "ConnectionsUnavailable" } });
    expect(token).toMatchObject({ failure: { _tag: "ConnectionsUnavailable" } });
  });

  it("knows nothing about someone who never ran /connect", async () => {
    const service = connectionsWith({ github: client });
    expect(await Effect.runPromise(service.list(nameless))).toEqual([]);
    expect(await Effect.runPromise(service.disconnect(nameless, "github"))).toBe(false);
    const token = await Effect.runPromise(Effect.result(service.accessToken(nameless, "github")));
    expect(token).toMatchObject({
      failure: { _tag: "NotConnected", message: "u1 has not linked a github account." },
    });
  });

  it("issues a fresh one-time link each time, for the same person", async () => {
    const service = connectionsWith({ google: client });
    const first = await Effect.runPromise(service.connectUrl(nameless, "google"));
    const second = await Effect.runPromise(service.connectUrl(nameless, "google"));
    expect(first).toMatch(/^http:\/\/localhost:8080\/connect\/[\w-]{40,}$/);
    expect(second).not.toBe(first);
    expect(await Effect.runPromise(service.list(nameless))).toEqual([]);
  });
});

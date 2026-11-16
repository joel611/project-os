import { Database } from "bun:sqlite";
import { migrationsFolder } from "@project-os/db-sqlite/migrations-folder";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { OAuthClientConfig } from "./auth.ts";
import { authOf } from "./test-auth.ts";
import { emailFor, isChannelIdentityEmail, personFromIdentityEmail } from "./connections.ts";

// The OAuth round trip runs in apps/e2e (connect-accounts) against a fake provider.
// These cover what happens without one: unconfigured providers and unknown people.

const client: OAuthClientConfig = { clientId: "id", clientSecret: "secret" };

const connectionsWith = (providers: { google?: OAuthClientConfig; github?: OAuthClientConfig }) => {
  const db = drizzle({ client: new Database(":memory:") });
  migrate(db, { migrationsFolder });
  return authOf({
    db,
    baseURL: "http://localhost:8080",
    secret: "unit-test-secret-unit-test-secret",
    ...providers,
  }).connections!.service;
};

const nameless = { channelType: "discord" as const, id: "u1" };

describe("personFromIdentityEmail", () => {
  it("reads back the person emailFor stored, with their name unless it is just the id", () => {
    const email = emailFor({ channelType: "discord", id: "123" });
    expect(personFromIdentityEmail(email, "Ada")).toEqual({
      channelType: "discord",
      id: "123",
      name: "Ada",
    });
    expect(personFromIdentityEmail(email, "123")).toEqual({ channelType: "discord", id: "123" });
    expect(personFromIdentityEmail(emailFor({ channelType: "email", id: "a@b.co" }))).toEqual({
      channelType: "email",
      id: "a@b.co",
    });
  });

  it("is undefined for anything that isn't a channel identity", () => {
    expect(personFromIdentityEmail("ops@example.com")).toBeUndefined();
    expect(personFromIdentityEmail("discord@people.project-os.invalid")).toBeUndefined();
    expect(personFromIdentityEmail("-1@people.project-os.invalid")).toBeUndefined();
    expect(personFromIdentityEmail("discord-@people.project-os.invalid")).toBeUndefined();
    expect(personFromIdentityEmail("slack-1@people.project-os.invalid")).toBeUndefined();
  });
});

describe("channel identities", () => {
  it("get a stable placeholder email that no operator can have", () => {
    const email = emailFor({ channelType: "discord", id: "U1" });
    expect(email).toBe("discord-u1@people.project-os.invalid");
    expect(isChannelIdentityEmail(email)).toBe(true);
    expect(isChannelIdentityEmail("DISCORD-U1@People.Project-OS.invalid")).toBe(true);
    expect(isChannelIdentityEmail("ops@example.com")).toBe(false);
  });
});

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

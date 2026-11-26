import { GMAIL_READ_SCOPE } from "@project-os/contracts";
import {
  ConnectionsUnavailable,
  EmailSource,
  getMyEmail,
  NotConnected,
  Scheduler,
  setMailboxEnabled,
  type UserAccessToken,
  UserConnections,
} from "@project-os/core";
import { makeTestLayer } from "@project-os/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  emailClassifier,
  emailDigestAndLog,
  emailDigestEnabled,
  gmailEmailSource,
  startEmailDigest,
} from "./index.ts";

const ada = { channelType: "discord", id: "u1" } as const;
const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const connections = (
  result: UserAccessToken | "not_connected" | "unavailable",
): Layer.Layer<UserConnections> =>
  Layer.succeed(UserConnections, {
    connectUrl: () => Effect.succeed("http://connect.test"),
    list: () => Effect.succeed([]),
    disconnect: () => Effect.succeed(false),
    accessToken: () =>
      result === "not_connected"
        ? Effect.fail(
            new NotConnected({ provider: "google", personId: "u1", message: "not linked" }),
          )
        : result === "unavailable"
          ? Effect.fail(new ConnectionsUnavailable({ message: "off" }))
          : Effect.succeed(result),
  });

describe("gmailEmailSource", () => {
  const scoped: UserAccessToken = {
    accessToken: "tok",
    expiresAt: null,
    scopes: [GMAIL_READ_SCOPE],
  };
  const gmail = async (input: string) =>
    input.endsWith("/profile")
      ? Response.json({ historyId: "42" })
      : input.includes("/history")
        ? Response.json({
            history: [{ id: "43", messagesAdded: [{ message: { id: "m1" } }] }],
            historyId: "50",
          })
        : Response.json({
            id: "m1",
            threadId: "t1",
            labelIds: ["INBOX"],
            internalDate: "1795000000000",
            payload: {
              headers: [
                { name: "From", value: "Dana <d@x.test>" },
                { name: "Subject", value: "Hi" },
              ],
              mimeType: "text/plain",
              body: { data: b64("hello") },
            },
          });

  const run = (token: Parameters<typeof connections>[0], cursor: string | null = null) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* EmailSource;
        return yield* source
          .sync({ owner: ada, label: "all", cursor, limit: 5 })
          .pipe(Effect.result);
      }).pipe(
        Effect.provide(gmailEmailSource({ fetch: gmail }).pipe(Layer.provide(connections(token)))),
      ),
    );

  it("reads mail with the person's own token", async () => {
    expect(await run(scoped)).toMatchObject({
      _tag: "Success",
      success: { cursor: "42", messages: [] },
    });
    const next = await run(scoped, "40");
    expect(next).toMatchObject({ _tag: "Success", success: { cursor: "50" } });
    expect((next as unknown as { success: { messages: unknown[] } }).success.messages).toHaveLength(
      1,
    );
  });

  it("asks to reconnect when there is no link or the link has no Gmail scope", async () => {
    const none = await run("not_connected");
    expect(none).toMatchObject({ _tag: "Failure", failure: { reconnect: true } });
    const old = await run({ accessToken: "tok", expiresAt: null, scopes: ["openid"] });
    expect(old).toMatchObject({ _tag: "Failure", failure: { reconnect: true } });
  });

  it("does not ask to reconnect when linking is just unavailable or Gmail is down", async () => {
    expect(await run("unavailable")).toMatchObject({
      _tag: "Failure",
      failure: { reconnect: false },
    });
    const down = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* EmailSource)
          .sync({ owner: ada, label: "all", cursor: null, limit: 1 })
          .pipe(Effect.result);
      }).pipe(
        Effect.provide(
          gmailEmailSource({ fetch: async () => new Response("", { status: 503 }) }).pipe(
            Layer.provide(connections(scoped)),
          ),
        ),
      ),
    );
    expect(down).toMatchObject({ _tag: "Failure", failure: { reconnect: false } });
    const refused = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* EmailSource)
          .sync({ owner: ada, label: "all", cursor: null, limit: 1 })
          .pipe(Effect.result);
      }).pipe(
        Effect.provide(
          gmailEmailSource({ fetch: async () => new Response("", { status: 401 }) }).pipe(
            Layer.provide(connections(scoped)),
          ),
        ),
      ),
    );
    expect(refused).toMatchObject({ _tag: "Failure", failure: { reconnect: true } });
  });
});

describe("gmailEmailSource labels", () => {
  const scoped: UserAccessToken = {
    accessToken: "tok",
    expiresAt: null,
    scopes: [GMAIL_READ_SCOPE],
  };
  const labels = (token: Parameters<typeof connections>[0], status = 200) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* EmailSource).labels(ada).pipe(Effect.result);
      }).pipe(
        Effect.provide(
          gmailEmailSource({
            fetch: async () =>
              status === 200
                ? Response.json({ labels: [{ id: "Label_1", name: "Clients", type: "user" }] })
                : new Response("", { status }),
          }).pipe(Layer.provide(connections(token))),
        ),
      ),
    );

  it("lists the person's labels with their own token", async () => {
    expect(await labels(scoped)).toMatchObject({
      _tag: "Success",
      success: [{ id: "Label_1", name: "Clients" }],
    });
  });

  it("asks to reconnect with no Gmail access, and reports Gmail being down", async () => {
    expect(await labels("not_connected")).toMatchObject({ failure: { reconnect: true } });
    expect(await labels(scoped, 503)).toMatchObject({ failure: { reconnect: false } });
  });
});

describe("emailDigestEnabled", () => {
  it("is off unless EMAIL_DIGEST is set", () => {
    expect(emailDigestEnabled({})).toBe(false);
    expect(emailDigestEnabled({ EMAIL_DIGEST: "true" })).toBe(true);
  });
});

describe("emailClassifier", () => {
  it("fails at startup for a decision model the catalog lacks", () => {
    const models = { classify: async () => ({}) as never, getModelOfType: () => undefined };
    expect(() => emailClassifier(models, { provider: "x", modelId: "y" })).toThrow(
      "Unknown decision model",
    );
  });
});

describe("emailDigestAndLog and startEmailDigest", () => {
  it("logs a run that read mail, and survives one that cannot run", async () => {
    const t = makeTestLayer({ now: new Date("2026-11-24T12:00:00.000Z") });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* emailDigestAndLog();
        t.emailSource.deliver(ada, {
          messageId: "g1",
          threadId: "t1",
          fromName: null,
          fromAddress: "d@x.test",
          subject: "Hi",
          body: "hello",
          receivedAt: "2026-11-24T11:00:00.000Z",
        });
        yield* emailDigestAndLog();
        const mine = yield* getMyEmail(ada, true);
        expect(mine.lastSyncAt).not.toBeNull();
      }).pipe(Effect.provide(t.layer)),
    );
    // No repositories in scope: the run dies, which is logged, not thrown.
    await expect(
      Effect.runPromise(emailDigestAndLog() as Effect.Effect<void>),
    ).resolves.toBeUndefined();
  });

  it("registers a recurring run with the Scheduler", async () => {
    const t = makeTestLayer();
    const registered: Array<{ name: string; everyMs: number }> = [];
    const layer = Layer.mergeAll(
      t.layer,
      Layer.succeed(Scheduler, {
        every: (name, everyMs) => {
          registered.push({ name, everyMs });
          return Effect.succeed(Effect.void);
        },
      }),
    );
    const stop = await Effect.runPromise(startEmailDigest(60_000).pipe(Effect.provide(layer)));
    expect(stop).toBeDefined();
    expect(registered).toEqual([{ name: "email-digest", everyMs: 60_000 }]);
  });
});

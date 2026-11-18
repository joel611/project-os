import { ChannelGateway } from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeLifecycleNotifications } from "./lifecycle.ts";

const setup = (
  options: {
    channelId?: string;
    ready?: Promise<void>;
    send?: () => Promise<void>;
    retryStartup?: boolean;
    timeoutMs?: number;
  } = {},
) => {
  const messages: string[] = [];
  const errors: string[] = [];
  const gateway = {
    send: (reply: { content: string }) =>
      Effect.promise(async () => {
        await options.send?.();
        messages.push(reply.content);
      }),
  } as unknown as typeof ChannelGateway.Service;
  const lifecycle = makeLifecycleNotifications({
    channelId: options.channelId,
    ready: options.ready,
    retryStartup: options.retryStartup ?? false,
    timeoutMs: options.timeoutMs,
    run: (effect) => Effect.runPromise(Effect.provideService(effect, ChannelGateway, gateway)),
    log: (message) => errors.push(message),
  });
  return { ...lifecycle, messages, errors };
};

describe("coordinator lifecycle notifications", () => {
  it("waits for Discord login and sends one stop for repeated shutdowns", async () => {
    let ready!: () => void;
    const lifecycle = setup({
      channelId: "admin",
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
    });
    expect(lifecycle.messages).toEqual([]);
    ready();
    await lifecycle.started;
    await Promise.all([lifecycle.stop(), lifecycle.stop()]);
    expect(lifecycle.messages).toEqual(["Coordinator started.", "Coordinator stopped."]);
  });

  it("does not send a late start when stopped before login", async () => {
    let ready!: () => void;
    const lifecycle = setup({
      channelId: "admin",
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
    });
    await lifecycle.stop();
    ready();
    await lifecycle.started;
    expect(lifecycle.messages).toEqual(["Coordinator stopped."]);
  });

  it("skips delivery without an admin channel", async () => {
    const lifecycle = setup();
    await lifecycle.started;
    await lifecycle.stop();
    expect(lifecycle.messages).toEqual([]);
  });

  it("bounds failed or stuck delivery and logs failures", async () => {
    const lifecycle = setup({
      channelId: "admin",
      timeoutMs: 20,
      send: () => new Promise(() => {}),
    });
    await lifecycle.started;
    await lifecycle.stop();
    expect(lifecycle.errors).toEqual([
      "Coordinator started notification failed",
      "Coordinator stopped notification failed",
    ]);
  });

  it("logs a failed startup delivery without retrying", async () => {
    const lifecycle = setup({
      channelId: "admin",
      send: () => Promise.reject(new Error("unavailable")),
    });
    await lifecycle.started;
    expect(lifecycle.errors).toEqual(["Coordinator started notification failed"]);
  });

  it("stops retrying if an in-flight startup fails during shutdown", async () => {
    let reject!: (error: Error) => void;
    let called!: () => void;
    const sent = new Promise<void>((resolve) => {
      called = resolve;
    });
    let attempts = 0;
    const lifecycle = setup({
      channelId: "admin",
      retryStartup: true,
      send: () => {
        if (++attempts > 1) return Promise.resolve();
        called();
        return new Promise<void>((_, fail) => {
          reject = fail;
        });
      },
    });
    await sent;
    const stopped = lifecycle.stop();
    reject(new Error("unavailable"));
    await stopped;
    expect(lifecycle.messages).toEqual(["Coordinator stopped."]);
  });

  it("logs login failure and still attempts shutdown delivery", async () => {
    const lifecycle = setup({
      channelId: "admin",
      ready: Promise.reject(new Error("login failed")),
    });
    await lifecycle.started;
    await lifecycle.stop();
    expect(lifecycle.errors).toEqual(["Coordinator started notification failed"]);
    expect(lifecycle.messages).toEqual(["Coordinator stopped."]);
  });
});

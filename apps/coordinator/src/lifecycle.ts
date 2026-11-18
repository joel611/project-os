import { ChannelGateway } from "@project-os/core";
import { Effect } from "effect";

type LifecycleEvent = "started" | "stopped";

export const makeLifecycleNotifications = (options: {
  readonly channelId?: string | undefined;
  readonly run: (effect: Effect.Effect<void, never, ChannelGateway>) => Promise<void>;
  readonly ready?: Promise<void> | undefined;
  readonly retryStartup?: boolean;
  readonly timeoutMs?: number | undefined;
  readonly log?: (message: string, error: unknown) => void;
}) => {
  const timeoutMs = options.timeoutMs ?? 3000;
  const log = options.log ?? console.error;
  let stopping = false;
  let cancelStartup!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    cancelStartup = resolve;
  });

  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("lifecycle notification timed out")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const send = (event: LifecycleEvent) =>
    options.run(
      Effect.flatMap(ChannelGateway, (gateway) =>
        gateway.send({
          channelType: "discord",
          channelId: options.channelId!,
          content: `Coordinator ${event}.`,
        }),
      ),
    );

  const start = options.channelId
    ? (async () => {
        try {
          await bounded(Promise.race([options.ready ?? Promise.resolve(), cancelled]));
          if (stopping) return;
          let active = true;
          try {
            await bounded(
              (async () => {
                while (active && !stopping) {
                  try {
                    await send("started");
                    return;
                  } catch (error) {
                    if (!options.retryStartup || stopping) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 250));
                  }
                }
              })(),
            );
          } finally {
            active = false;
          }
        } catch (error) {
          log("Coordinator started notification failed", error);
        }
      })()
    : Promise.resolve();

  let stop: Promise<void> | undefined;
  return {
    started: start,
    stop: () =>
      (stop ??= (async () => {
        stopping = true;
        cancelStartup();
        await start;
        if (!options.channelId) return;
        try {
          await bounded(send("stopped"));
        } catch (error) {
          log("Coordinator stopped notification failed", error);
        }
      })()),
  };
};

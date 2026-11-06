import type { TicketStatus } from "@project-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Module, Packet, Story } from "./feed.ts";

export interface Trip {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly packet: Packet;
  readonly start: number;
  readonly duration: number;
  readonly done: () => void;
}

export const DURATION_MS: Readonly<Record<Packet["kind"], number>> = {
  message: 1100,
  reply: 1100,
  ticket: 1000,
  call: 650,
};
export const FLASH_MS = 900;
const FLASH_PAUSE_MS = 300;

export interface Player {
  readonly trips: ReadonlyArray<Trip>;
  readonly now: number;
  /** Ticket statuses as far as the animation has got. */
  readonly shown: ReadonlyMap<string, TicketStatus>;
  readonly play: (story: Story) => void;
  readonly settle: (statuses: Iterable<readonly [string, TicketStatus]>) => void;
  /** Whether a Coordinator module lit up within the last `FLASH_MS`. */
  readonly isFlashing: (m: Module) => boolean;
}

const never = (): Record<Module, number> => ({
  jev: -Infinity,
  tickets: -Infinity,
  mcp: -Infinity,
  pi: -Infinity,
});

/**
 * Plays ticket stories: one ticket's steps run in order, different tickets run side by side.
 * Re-renders every animation frame while anything moves, and not at all when idle. With
 * `reducedMotion`, statuses still update but nothing travels or pauses.
 */
export const usePlayer = (
  canTravel: (from: string, to: string) => boolean,
  reducedMotion: boolean,
): Player => {
  const trips = useRef<Trip[]>([]);
  const flashes = useRef(never());
  const shown = useRef(new Map<string, TicketStatus>());
  const chains = useRef(new Map<string, Promise<void>>());
  const nextId = useRef(0);
  const frame = useRef<number | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const latest = useRef({ canTravel, reducedMotion });
  latest.current = { canTravel, reducedMotion };

  const tick = useCallback((t: number) => {
    frame.current = null;
    const finished = trips.current.filter((trip) => t - trip.start >= trip.duration);
    trips.current = trips.current.filter((trip) => t - trip.start < trip.duration);
    finished.forEach((trip) => trip.done());
    setNow(t);
    const flashing = Object.values(flashes.current).some((at) => t - at < FLASH_MS);
    if (trips.current.length > 0 || flashing) frame.current = requestAnimationFrame(tick);
  }, []);

  const wake = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const run = useCallback(
    async (story: Story) => {
      for (const step of story.steps) {
        const { canTravel, reducedMotion } = latest.current;
        if (step.type === "status") {
          shown.current.set(step.ticketId, step.status);
          setNow(performance.now());
        } else if (step.type === "flash") {
          flashes.current[step.module] = performance.now();
          wake();
          if (!reducedMotion) await new Promise((r) => setTimeout(r, FLASH_PAUSE_MS));
        } else if (!reducedMotion && canTravel(step.from, step.to)) {
          await new Promise<void>((done) => {
            trips.current.push({
              id: nextId.current++,
              from: step.from,
              to: step.to,
              packet: step.packet,
              start: performance.now(),
              duration: DURATION_MS[step.packet.kind],
              done,
            });
            wake();
          });
        }
      }
    },
    [wake],
  );

  const play = useCallback(
    (story: Story) => {
      const previous = chains.current.get(story.ticketId) ?? Promise.resolve();
      const next = previous.then(() => run(story));
      chains.current.set(story.ticketId, next);
      void next.then(() => {
        if (chains.current.get(story.ticketId) === next) chains.current.delete(story.ticketId);
      });
    },
    [run],
  );

  const settle = useCallback((statuses: Iterable<readonly [string, TicketStatus]>) => {
    for (const [id, status] of statuses) shown.current.set(id, status);
    setNow(performance.now());
  }, []);

  return {
    trips: trips.current,
    now,
    shown: shown.current,
    play,
    settle,
    isFlashing: (m) => now - flashes.current[m] < FLASH_MS,
  };
};

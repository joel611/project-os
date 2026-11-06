import type { ActivityTicket, ChannelType, TicketStatus } from "@project-os/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import { QueryError } from "@/components/states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  applyFeed,
  channelsOf,
  emptyModel,
  ticketLabel,
  workerKey,
  workerSlots,
  type MapModel,
} from "./feed.ts";
import { IsoScene } from "./iso-scene.tsx";
import { layout as makeLayout, nodeId, type Layout } from "./iso.ts";
import { usePlayer, type Player } from "./player.ts";
import type { WorkerView } from "./scene.tsx";
import { SchematicScene } from "./schematic-scene.tsx";
import { EventLogCard, TicketsCard } from "./activity-panels.tsx";

type MapStyle = "schematic" | "isometric";
const STYLE_KEY = "system-map-style";

/** The viewer's chosen style, remembered in this browser. Schematic unless they picked another. */
const useMapStyle = () => {
  const [style, setStyle] = useState<MapStyle>(() => {
    try {
      return localStorage.getItem(STYLE_KEY) === "isometric" ? "isometric" : "schematic";
    } catch {
      return "schematic";
    }
  });
  const choose = (next: MapStyle) => {
    setStyle(next);
    try {
      localStorage.setItem(STYLE_KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  };
  return [style, choose] as const;
};

const POLL_MS = 2000;

/** Polls `GET /activity` and turns each read into stories for the player. */
const useActivity = (player: Player) => {
  const [model, setModel] = useState<MapModel>(emptyModel);
  const [error, setError] = useState<Error | null>(null);
  const modelRef = useRef(model);
  const { play, settle } = player;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const feed = await api.activity(modelRef.current.since);
        if (stopped) return;
        const baseline = modelRef.current.since === null;
        const next = applyFeed(modelRef.current, feed);
        modelRef.current = next.model;
        setModel(next.model);
        setError(null);
        if (baseline) settle(feed.tickets.map((t) => [t.id, t.status] as const));
        next.stories.forEach(play);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e : new Error(String(e)));
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [play, settle]);

  return { model, error };
};

/** The live system map of channels, adapters, the Coordinator and Workers, in either style. */
export const SystemMap = () => {
  const mapRef = useRef<Layout | null>(null);
  const [reducedMotion] = useState(
    () =>
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const player = usePlayer(
    (from, to) => Boolean(mapRef.current?.byId.has(from) && mapRef.current.byId.has(to)),
    reducedMotion,
  );
  const { model, error } = useActivity(player);
  const [style, setStyle] = useMapStyle();

  const tickets = [...model.tickets.values()];
  const channelKey = channelsOf(tickets).join(",");
  const slots = workerSlots(model.workers, tickets);
  const slotKey = slots.map((s) => `${s.id}:${s.workerType}`).join(",");
  const map = useMemo(
    () => makeLayout(channelKey.split(",") as ChannelType[], slots),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content, not identity
    [channelKey, slotKey],
  );
  mapRef.current = map;

  const shownStatus = (t: ActivityTicket): TicketStatus => player.shown.get(t.id) ?? t.status;
  const waiting = tickets.filter((t) => shownStatus(t) === "assigned");
  const running = tickets.filter((t) => shownStatus(t) === "in_progress");
  const coordinatorLine = `${waiting.length} waiting for pull · ${running.length} in progress`;

  const workerViews = new Map<string, WorkerView>();
  for (const slot of slots) {
    const mine = (s: TicketStatus) =>
      tickets.filter((t) => workerKey(t) === slot.id && shownStatus(t) === s);
    const work = mine("in_progress")[0];
    const queued = mine("assigned").length;
    const known = model.workers.find((w) => w.id === slot.id);
    const presence = known ? known.status : "not checked in";
    workerViews.set(nodeId.worker(slot.id), {
      working: Boolean(work),
      offline: !known || known.status === "offline",
      line: work
        ? `working ${ticketLabel(work.id)}${queued ? ` · ${queued} waiting` : ""}`
        : queued
          ? `${presence} · ${queued} waiting`
          : presence === "online"
            ? "idle"
            : presence,
    });
  }

  const scene = { map, player, workers: workerViews, waiting, coordinatorLine };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        {error ? <QueryError error={error} /> : <span />}
        <Tabs value={style} onValueChange={(v) => setStyle(v as MapStyle)}>
          <TabsList aria-label="Map style">
            <TabsTrigger value="schematic">Schematic</TabsTrigger>
            <TabsTrigger value="isometric">Isometric</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className={`map-stage map-${style} overflow-x-auto rounded-xl border`}>
        {style === "schematic" ? <SchematicScene {...scene} /> : <IsoScene {...scene} />}
      </div>
      {slots.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No worker has checked in. Workers appear on the right once the Watcher or a sandbox sends
          its first heartbeat.
        </p>
      )}
      <div className="map-lower">
        <TicketsCard tickets={tickets} statusOf={shownStatus} />
        <EventLogCard lines={model.log} />
      </div>
    </div>
  );
};

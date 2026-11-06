import type { ActivityTicket, ChannelType, TicketStatus } from "@project-os/contracts";
import {
  Brain,
  Cloud,
  Laptop,
  Mail,
  MessageCircle,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import { QueryError } from "@/components/states";
import { relativeTime } from "@/model";
import { useNow } from "@/use-now";
import {
  applyFeed,
  channelsOf,
  emptyModel,
  identityOf,
  ticketLabel,
  workerKey,
  workerSlots,
  type Identity,
  type MapModel,
  type Module,
  type Packet,
} from "./feed.ts";
import {
  depthOrder,
  face,
  layout as makeLayout,
  nodeId,
  onLeftFace,
  onTop,
  packetAt,
  project,
  UNIT,
  type Layout,
  type MapNode,
} from "./iso.ts";
import { usePlayer, type Player, type Trip } from "./player.ts";

const POLL_MS = 2000;

const CHANNEL_ICON: Readonly<Record<ChannelType, LucideIcon>> = {
  discord: MessageCircle,
  email: Mail,
  chat: MessagesSquare,
};
const CHANNEL_COLOR: Readonly<Record<ChannelType, string>> = {
  discord: "var(--iso-discord)",
  email: "var(--iso-email)",
  chat: "var(--iso-chat)",
};
const MODULES: ReadonlyArray<readonly [Module, string, number, number]> = [
  ["jev", "Jev", -0.28, -0.22],
  ["tickets", "Tickets", 0.22, -0.22],
  ["mcp", "MCP", -0.28, 0.18],
  ["pi", "Pi reply", 0.22, 0.18],
];

const nodeIcon = (n: MapNode): LucideIcon => {
  if (n.kind === "coordinator") return Brain;
  if (n.kind === "worker") return n.workerType === "daytona_pi" ? Cloud : Laptop;
  return CHANNEL_ICON[n.channel ?? "chat"];
};

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

const Avatar = ({ who, r = 13 }: { who: Identity; r?: number }) => {
  const Badge = CHANNEL_ICON[who.channel];
  return (
    <g>
      <title>{who.name}</title>
      <circle r={r} fill={who.color} stroke="var(--iso-bg)" strokeWidth={2} />
      <text y={r * 0.27} textAnchor="middle" className="iso-initials" fontSize={r * 0.77}>
        {who.initials}
      </text>
      <g transform={`translate(${r * 0.77} ${-r * 0.77})`}>
        <circle r={7} fill={CHANNEL_COLOR[who.channel]} stroke="var(--iso-bg)" strokeWidth={1.5} />
        <Badge x={-4.25} y={-4.25} width={8.5} height={8.5} color="#fff" strokeWidth={2.5} />
      </g>
    </g>
  );
};

const PacketBody = ({ packet }: { packet: Packet }) => {
  switch (packet.kind) {
    case "message":
      return <Avatar who={packet.who} />;
    case "reply":
      return (
        <g>
          <rect x={-38} y={-11} width={76} height={22} rx={11} className="iso-reply" />
          {packet.who && (
            <g transform="translate(-26 0)">
              <circle r={8} fill={packet.who.color} stroke="#fff" strokeWidth={1.2} />
              <text y={2.6} textAnchor="middle" className="iso-initials" fontSize={7}>
                {packet.who.initials}
              </text>
            </g>
          )}
          <text x={packet.who ? 6 : 0} y={4} textAnchor="middle" className="iso-chip-text">
            reply
          </text>
        </g>
      );
    case "ticket":
      return (
        <g>
          <rect
            x={-31}
            y={-11}
            width={62}
            height={22}
            rx={6}
            className={`iso-chip iso-chip-${packet.tone}`}
          />
          <text y={4} textAnchor="middle" className="iso-chip-text">
            {packet.tone === "done" ? "✓ " : packet.tone === "failed" ? "✕ " : ""}
            {ticketLabel(packet.ticketId)}
          </text>
        </g>
      );
    case "call":
      return (
        <g>
          <circle r={4.5} className="iso-call" />
          <text y={-10} textAnchor="middle" className="iso-call-label">
            {packet.label}
          </text>
        </g>
      );
  }
};

const Packets = ({ trips, now, map }: { trips: ReadonlyArray<Trip>; now: number; map: Layout }) => (
  <>
    <g>
      {trips.map((trip) => {
        const a = map.byId.get(trip.from);
        const b = map.byId.get(trip.to);
        if (!a || !b) return null;
        const { floor } = packetAt(a, b, Math.min(1, (now - trip.start) / trip.duration));
        const big = trip.packet.kind !== "call";
        return (
          <ellipse
            key={trip.id}
            cx={floor.x}
            cy={floor.y}
            rx={big ? 14 : 5}
            ry={big ? 6 : 2.5}
            className="iso-shadow"
          />
        );
      })}
    </g>
    <g>
      {trips.map((trip) => {
        const a = map.byId.get(trip.from);
        const b = map.byId.get(trip.to);
        if (!a || !b) return null;
        const { at } = packetAt(a, b, Math.min(1, (now - trip.start) / trip.duration));
        return (
          <g key={trip.id} transform={`translate(${at.x} ${at.y})`}>
            <PacketBody packet={trip.packet} />
          </g>
        );
      })}
    </g>
  </>
);

interface WorkerView {
  readonly line: string;
  readonly working: boolean;
  readonly offline: boolean;
}

const Block = ({
  node,
  player,
  worker,
}: {
  node: MapNode;
  player: Player;
  worker: WorkerView | undefined;
}) => {
  const Icon = nodeIcon(node);
  const top = project(node.u, node.v, node.h);
  const kind = node.kind === "channel" ? "channel" : node.kind;
  return (
    <g className={`iso-block iso-${kind}${worker?.offline ? " iso-offline" : ""}`}>
      {node.h > 0 && (
        <>
          <polygon points={face(node, "left")} className="iso-face iso-l" />
          <polygon points={face(node, "right")} className="iso-face iso-r" />
        </>
      )}
      <polygon points={face(node, "top")} className="iso-face iso-t" />
      {node.kind === "coordinator" ? (
        MODULES.map(([key, label, du, dv]) => {
          const on = player.isFlashing(key);
          const width = label.length * 6.4 + 12;
          return (
            <g key={key} transform={onTop(project(node.u + du, node.v + dv, node.h))}>
              <rect
                x={-width / 2}
                y={-11}
                width={width}
                height={22}
                rx={4}
                className={on ? "iso-tile on" : "iso-tile"}
              />
              <text
                y={3.5}
                textAnchor="middle"
                className={on ? "iso-tile-text on" : "iso-tile-text"}
              >
                {label}
              </text>
            </g>
          );
        })
      ) : (
        <g transform={onTop(top)}>
          <Icon
            x={-11}
            y={-11}
            width={22}
            height={22}
            strokeWidth={2}
            color={node.channel ? CHANNEL_COLOR[node.channel] : "var(--iso-text)"}
          />
        </g>
      )}
      {node.kind === "worker" && (
        <g transform={onLeftFace(project(node.u - node.w, node.v + node.d, node.h * 0.3))}>
          <rect
            x={10}
            y={-4}
            width={node.w * 2 * UNIT - 20}
            height={6}
            rx={3}
            className="iso-track"
          />
          {worker?.working && (
            <rect
              x={10}
              y={-4}
              width={node.w * 2 * UNIT - 20}
              height={6}
              rx={3}
              className="iso-busy"
            />
          )}
        </g>
      )}
    </g>
  );
};

const Labels = ({
  node,
  coordinatorLine,
  worker,
}: {
  node: MapNode;
  coordinatorLine: string;
  worker: WorkerView | undefined;
}) => {
  const top = project(node.u, node.v, node.h);
  if (node.kind === "channel")
    return (
      <text x={top.x} y={top.y + 34} textAnchor="middle" className="iso-label">
        {node.label}
      </text>
    );
  const y =
    project(node.u - node.w, node.v - node.d, node.h).y - (node.kind === "coordinator" ? 26 : 12);
  const sub =
    node.kind === "coordinator"
      ? coordinatorLine
      : node.kind === "worker"
        ? (worker?.line ?? "")
        : node.sub;
  return (
    <g>
      <text x={top.x} y={y - 14} textAnchor="middle" className="iso-label">
        {node.kind === "worker" ? `${node.label} · ${node.sub}` : node.label}
      </text>
      <text
        x={top.x}
        y={y}
        textAnchor="middle"
        className={worker?.working ? "iso-sub iso-sub-busy" : "iso-sub"}
      >
        {sub}
      </text>
    </g>
  );
};

const Floor = ({ map }: { map: Layout }) => {
  const lines = [];
  for (let k = -12; k <= 12; k += 0.5) {
    const a = project(k, -12);
    const b = project(k, 12);
    const c = project(-12, k);
    const d = project(12, k);
    lines.push(
      <line key={`u${k}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />,
      <line key={`v${k}`} x1={c.x} y1={c.y} x2={d.x} y2={d.y} />,
    );
  }
  const { x, y, w, h } = map.viewBox;
  return (
    <>
      <rect x={x} y={y} width={w} height={h} className="iso-floor" />
      <g className="iso-grid">{lines}</g>
    </>
  );
};

/** The live isometric map of channels, adapters, the Coordinator and Workers. */
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
  const clock = useNow();

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

  const hot = new Set(player.trips.map((t) => [t.from, t.to].sort().join("|")));
  const coordinator = map.byId.get(nodeId.coordinator)!;
  const base = project(coordinator.u - coordinator.w, coordinator.v + coordinator.d);
  const { x, y, w, h } = map.viewBox;

  return (
    <div className="flex flex-col gap-4">
      {error && <QueryError error={error} />}
      <div className="iso-map overflow-x-auto rounded-xl border">
        <svg
          viewBox={`${x} ${y} ${w} ${h}`}
          className="block h-auto w-full min-w-[720px]"
          role="img"
          aria-label="Live system map: messages move from channels through adapters to the Coordinator and on to Workers"
        >
          <Floor map={map} />
          <g>
            {map.edges.map(([a, b]) => {
              const p = map.byId.get(a)!;
              const q = map.byId.get(b)!;
              const pa = project(p.u, p.v);
              const pb = project(q.u, q.v);
              return (
                <line
                  key={`${a}|${b}`}
                  x1={pa.x}
                  y1={pa.y}
                  x2={pb.x}
                  y2={pb.y}
                  className={hot.has([a, b].sort().join("|")) ? "iso-rail hot" : "iso-rail"}
                />
              );
            })}
          </g>
          <g>
            {depthOrder(map.nodes).map((n) => (
              <Block key={n.id} node={n} player={player} worker={workerViews.get(n.id)} />
            ))}
          </g>
          <g>
            {waiting.slice(0, 4).map((t, i) => (
              <g key={t.id} transform={`translate(${base.x - 30 + i * 8} ${base.y + 14 + i * 4})`}>
                <title>{t.title}</title>
                <rect
                  x={-28}
                  y={-10}
                  width={56}
                  height={20}
                  rx={5}
                  className="iso-chip iso-chip-work"
                />
                <text y={4} textAnchor="middle" className="iso-chip-text">
                  {ticketLabel(t.id)}
                </text>
              </g>
            ))}
          </g>
          <Packets trips={player.trips} now={player.now} map={map} />
          <g>
            {map.nodes.map((n) => (
              <Labels
                key={n.id}
                node={n}
                coordinatorLine={coordinatorLine}
                worker={workerViews.get(n.id)}
              />
            ))}
          </g>
        </svg>
      </div>
      {slots.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No worker has checked in. Workers appear on the right once the Watcher or a sandbox sends
          its first heartbeat.
        </p>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Recent activity</h2>
        {model.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing in the last 15 minutes.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border text-sm">
            {model.recent.map((e) => {
              const t = model.tickets.get(e.ticketId);
              const who = t?.origin ? identityOf(t.origin) : null;
              return (
                <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {relativeTime(e.createdAt, clock)}
                  </span>
                  <span className="w-24 shrink-0 font-mono text-xs">{e.type}</span>
                  {who && (
                    <span
                      className="grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-white"
                      style={{ background: who.color }}
                      title={who.name}
                    >
                      {who.initials}
                    </span>
                  )}
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-xs text-muted-foreground">
                      {ticketLabel(e.ticketId)}
                    </span>{" "}
                    {e.body || t?.title}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};

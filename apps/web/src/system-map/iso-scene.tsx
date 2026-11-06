import {
  depthOrder,
  face,
  onLeftFace,
  onTop,
  packetAt,
  project,
  UNIT,
  type Layout,
  type MapNode,
} from "./iso.ts";
import type { Player, Trip } from "./player.ts";
import {
  CHANNEL_COLOR,
  edgeKey,
  hotEdges,
  MODULES,
  nodeIcon,
  PacketBody,
  progressOf,
  WaitingChip,
  type SceneProps,
  type WorkerView,
} from "./scene.tsx";

/** Where each Coordinator tile sits on its roof, as floor-grid offsets from the centre. */
const TILE_SPOT: ReadonlyArray<readonly [number, number]> = [
  [-0.28, -0.22],
  [0.22, -0.22],
  [-0.28, 0.18],
  [0.22, 0.18],
];

const Packets = ({ trips, now, map }: { trips: ReadonlyArray<Trip>; now: number; map: Layout }) => {
  const placed = trips.flatMap((trip) => {
    const a = map.byId.get(trip.from);
    const b = map.byId.get(trip.to);
    return a && b ? [{ trip, ...packetAt(a, b, progressOf(trip, now)) }] : [];
  });
  return (
    <>
      <g>
        {placed.map(({ trip, floor }) => {
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
        {placed.map(({ trip, at }) => (
          <g key={trip.id} transform={`translate(${at.x} ${at.y})`}>
            <PacketBody packet={trip.packet} />
          </g>
        ))}
      </g>
    </>
  );
};

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
  return (
    <g className={`iso-block iso-${node.kind}${worker?.offline ? " iso-offline" : ""}`}>
      {node.h > 0 && (
        <>
          <polygon points={face(node, "left")} className="iso-face iso-l" />
          <polygon points={face(node, "right")} className="iso-face iso-r" />
        </>
      )}
      <polygon points={face(node, "top")} className="iso-face iso-t" />
      {node.kind === "coordinator" ? (
        MODULES.map(([key, label], i) => {
          const on = player.isFlashing(key);
          const width = label.length * 6.4 + 12;
          const [du, dv] = TILE_SPOT[i]!;
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
            color={node.channel ? CHANNEL_COLOR[node.channel] : "var(--map-text)"}
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
              className="map-busy"
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
      <text x={top.x} y={top.y + 34} textAnchor="middle" className="map-label">
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
      <text x={top.x} y={y - 14} textAnchor="middle" className="map-label">
        {node.kind === "worker" ? `${node.label} · ${node.sub}` : node.label}
      </text>
      <text
        x={top.x}
        y={y}
        textAnchor="middle"
        className={worker?.working ? "map-sub map-sub-busy" : "map-sub"}
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

/** Isometric style: blocks on a floor plan, packets floating over the rails. */
export const IsoScene = ({ map, player, workers, waiting, coordinatorLine }: SceneProps) => {
  const hot = hotEdges(player.trips);
  const coordinator = map.byId.get("coordinator")!;
  const base = project(coordinator.u - coordinator.w, coordinator.v + coordinator.d);
  const { x, y, w, h } = map.viewBox;
  return (
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
              key={edgeKey(a, b)}
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              className={hot.has(edgeKey(a, b)) ? "map-rail hot" : "map-rail"}
            />
          );
        })}
      </g>
      <g>
        {depthOrder(map.nodes).map((n) => (
          <Block key={n.id} node={n} player={player} worker={workers.get(n.id)} />
        ))}
      </g>
      <g>
        {waiting.slice(0, 4).map((t, i) => (
          <WaitingChip key={t.id} ticket={t} x={base.x - 30 + i * 8} y={base.y + 14 + i * 4} />
        ))}
      </g>
      <Packets trips={player.trips} now={player.now} map={map} />
      <g>
        {map.nodes.map((n) => (
          <Labels
            key={n.id}
            node={n}
            coordinatorLine={coordinatorLine}
            worker={workers.get(n.id)}
          />
        ))}
      </g>
    </svg>
  );
};

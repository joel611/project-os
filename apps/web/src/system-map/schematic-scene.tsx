import type { MapNode } from "./iso.ts";
import { boxOf, curveBetween, packetOnCurve, pathOf, schematicViewBox } from "./schematic.ts";
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
import type { Player } from "./player.ts";

const Card = ({
  node,
  player,
  worker,
  coordinatorLine,
}: {
  node: MapNode;
  player: Player;
  worker: WorkerView | undefined;
  coordinatorLine: string;
}) => {
  const Icon = nodeIcon(node);
  const b = boxOf(node);
  const x = b.x - b.w / 2;
  const y = b.y - b.h / 2;

  if (node.kind === "channel")
    return (
      <g>
        <rect x={x} y={y} width={b.w} height={b.h} rx={b.h / 2} className="sch-ghost" />
        <Icon x={x + 14} y={b.y - 8} width={16} height={16} color={CHANNEL_COLOR[node.channel!]} />
        <text x={x + 38} y={b.y + 4.5} className="sch-title">
          {node.label}
        </text>
      </g>
    );

  if (node.kind === "adapter")
    return (
      <g>
        <rect x={x} y={y} width={b.w} height={b.h} rx={10} className="sch-card" />
        <rect
          x={x + 12}
          y={b.y - 16}
          width={32}
          height={32}
          rx={8}
          fill={CHANNEL_COLOR[node.channel!]}
        />
        <Icon x={x + 19} y={b.y - 9} width={18} height={18} color="#fff" />
        <text x={x + 54} y={b.y - 2} className="sch-title">
          {node.label}
        </text>
        <text x={x + 54} y={b.y + 15} className="sch-sub">
          {node.sub}
        </text>
      </g>
    );

  if (node.kind === "coordinator") {
    let chipX = x + 16;
    return (
      <g>
        <rect x={x} y={y} width={b.w} height={b.h} rx={14} className="sch-card sch-coordinator" />
        <rect x={x + 16} y={y + 16} width={36} height={36} rx={9} className="sch-accent" />
        <Icon x={x + 24} y={y + 24} width={20} height={20} color="#fff" />
        <text x={x + 62} y={y + 31} className="sch-title sch-title-lg">
          {node.label}
        </text>
        <text x={x + 62} y={y + 48} className="sch-sub">
          Pi agent loop
        </text>
        {MODULES.map(([key, label]) => {
          const on = player.isFlashing(key);
          const width = label.length * 6.6 + 14;
          const at = chipX;
          chipX += width + 6;
          return (
            <g key={key}>
              <rect
                x={at}
                y={y + 68}
                width={width}
                height={22}
                rx={6}
                className={on ? "sch-chip on" : "sch-chip"}
              />
              <text
                x={at + width / 2}
                y={y + 83}
                textAnchor="middle"
                className={on ? "sch-chip-text on" : "sch-chip-text"}
              >
                {label}
              </text>
            </g>
          );
        })}
        <line x1={x + 16} x2={x + b.w - 16} y1={y + 106} y2={y + 106} className="sch-divider" />
        <text x={x + 16} y={y + 129} className="sch-sub">
          {coordinatorLine}
        </text>
      </g>
    );
  }

  return (
    <g className={worker?.offline ? "sch-offline" : undefined}>
      <rect x={x} y={y} width={b.w} height={b.h} rx={10} className="sch-card" />
      <rect x={x + 12} y={y + 12} width={30} height={30} rx={8} className="sch-icon-bg" />
      <Icon x={x + 18} y={y + 18} width={18} height={18} color="var(--map-text)" />
      <text x={x + 52} y={y + 26} className="sch-title">
        {node.label}
      </text>
      <text x={x + 52} y={y + 41} className="sch-sub">
        {node.sub}
      </text>
      <text x={x + 12} y={y + 64} className={worker?.working ? "sch-sub map-sub-busy" : "sch-sub"}>
        {worker?.line ?? ""}
      </text>
      <rect x={x + 12} y={y + 73} width={b.w - 24} height={4} rx={2} className="sch-track" />
      {worker?.working && (
        <rect x={x + 12} y={y + 73} width={b.w - 24} height={4} rx={2} className="map-busy" />
      )}
    </g>
  );
};

/** Schematic style: flat cards on a dot grid, joined by curves that march while busy. */
export const SchematicScene = ({ map, player, workers, waiting, coordinatorLine }: SceneProps) => {
  const hot = hotEdges(player.trips);
  const { x, y, w, h } = schematicViewBox(map.nodes);
  const coordinator = boxOf(map.byId.get("coordinator")!);
  return (
    <svg
      viewBox={`${x} ${y} ${w} ${h}`}
      className="block h-auto w-full min-w-[720px]"
      role="img"
      aria-label="Live system map: messages move from channels through adapters to the Coordinator and on to Workers"
    >
      <defs>
        <pattern id="sch-dots" width={22} height={22} patternUnits="userSpaceOnUse">
          <circle cx={1} cy={1} r={1} className="sch-dot" />
        </pattern>
      </defs>
      <rect x={x} y={y} width={w} height={h} fill="url(#sch-dots)" />
      <g>
        {map.edges.map(([a, b]) => (
          <path
            key={edgeKey(a, b)}
            d={pathOf(curveBetween(map.byId.get(a)!, map.byId.get(b)!))}
            className={hot.has(edgeKey(a, b)) ? "sch-edge hot" : "sch-edge"}
          />
        ))}
      </g>
      <g>
        {map.nodes.map((n) => (
          <Card
            key={n.id}
            node={n}
            player={player}
            worker={workers.get(n.id)}
            coordinatorLine={coordinatorLine}
          />
        ))}
      </g>
      <g>
        {waiting.slice(0, 4).map((t, i) => (
          <WaitingChip
            key={t.id}
            ticket={t}
            x={coordinator.x - coordinator.w / 2 + 28 + i * 62}
            y={coordinator.y + coordinator.h / 2 + 20}
          />
        ))}
      </g>
      <g>
        {player.trips.map((trip) => {
          const a = map.byId.get(trip.from);
          const b = map.byId.get(trip.to);
          if (!a || !b) return null;
          const at = packetOnCurve(a, b, progressOf(trip, player.now));
          return (
            <g key={trip.id} transform={`translate(${at.x} ${at.y})`}>
              <PacketBody packet={trip.packet} />
            </g>
          );
        })}
      </g>
    </svg>
  );
};

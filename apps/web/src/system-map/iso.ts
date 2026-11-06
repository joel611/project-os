import type { ChannelType, WorkerType } from "@project-os/contracts";

/** Pixels per floor-grid unit. */
export const UNIT = 96;
/** How high packets float above the floor rails. */
export const PACKET_LIFT = 14;

export type NodeKind = "channel" | "adapter" | "coordinator" | "worker";

export interface MapNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly sub: string;
  readonly channel?: ChannelType;
  readonly workerType?: WorkerType;
  /** Position on the left-to-right flow chart: columns of channels, adapters, Coordinator, Workers. */
  readonly x: number;
  readonly y: number;
  /** Floor-grid position of the block's centre. */
  readonly u: number;
  readonly v: number;
  /** Half extents on the floor grid, and height in pixels. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Layout {
  readonly nodes: ReadonlyArray<MapNode>;
  readonly byId: ReadonlyMap<string, MapNode>;
  readonly edges: ReadonlyArray<readonly [string, string]>;
  readonly viewBox: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

export const nodeId = {
  channel: (c: ChannelType) => `channel:${c}`,
  adapter: (c: ChannelType) => `adapter:${c}`,
  coordinator: "coordinator",
  worker: (id: string) => `worker:${id}`,
} as const;

/** Isometric projection of a floor-grid point lifted `z` pixels. */
export const project = (u: number, v: number, z = 0): Point => ({
  x: (u - v) * 0.866 * UNIT,
  y: (u + v) * 0.5 * UNIT - z,
});

const SIZE: Readonly<Record<NodeKind, readonly [number, number, number]>> = {
  channel: [0.3, 0.3, 0],
  adapter: [0.36, 0.3, 30],
  coordinator: [0.6, 0.52, 86],
  worker: [0.4, 0.32, 44],
};

const CHANNEL_LABEL: Readonly<Record<ChannelType, readonly [string, string, string]>> = {
  discord: ["Discord", "Discord adapter", "gateway ws"],
  email: ["Inbox", "Email adapter", "inbound mail"],
  chat: ["Chat", "Chat adapter", "web chat"],
};

export const WORKER_LABEL: Readonly<Record<WorkerType, string>> = {
  local_claude: "Claude Code",
  local_pi: "Pi (local)",
  daytona_pi: "Pi (Daytona)",
  sidekick: "Sidekick",
};

export interface WorkerSlot {
  readonly id: string;
  readonly workerType: WorkerType | null;
}

/** Logical columns, left to right: channels, adapters, Coordinator, Workers. */
const COLUMN = { channel: 0, adapter: 1.3, coordinator: 3, worker: 4.8 } as const;
const MID = 1.5;

/** Spread `n` rows evenly around the middle row, closer together as `n` grows. */
const rows = (n: number, spacing: number, span: number): number[] => {
  const step = n > 1 ? Math.min(spacing, span / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => MID + (i - (n - 1) / 2) * step);
};

/**
 * Places every block on the floor. Logical (x, y) is a left-to-right flow chart; it is turned
 * onto the isometric floor so the flow still reads left to right on screen.
 */
export const layout = (
  channels: ReadonlyArray<ChannelType>,
  workers: ReadonlyArray<WorkerSlot>,
): Layout => {
  const onFloor = (x: number, y: number) => {
    const kx = 0.98;
    const ky = 1.5;
    return { u: x * kx + (y - MID) * ky, v: -x * kx + (y - MID) * ky };
  };
  const make = (
    id: string,
    kind: NodeKind,
    x: number,
    y: number,
    rest: Pick<MapNode, "label" | "sub"> & Partial<MapNode>,
  ): MapNode => {
    const [w, d, h] = SIZE[kind];
    return { id, kind, x, y, ...onFloor(x, y), w, d, h, ...rest };
  };

  const nodes: MapNode[] = [];
  const edges: Array<readonly [string, string]> = [];
  rows(channels.length, 1.6, 1.6).forEach((y, i) => {
    const c = channels[i]!;
    const [place, adapter, sub] = CHANNEL_LABEL[c];
    nodes.push(
      make(nodeId.channel(c), "channel", COLUMN.channel, y, { label: place, sub: "", channel: c }),
    );
    nodes.push(
      make(nodeId.adapter(c), "adapter", COLUMN.adapter, y, { label: adapter, sub, channel: c }),
    );
    edges.push([nodeId.channel(c), nodeId.adapter(c)], [nodeId.adapter(c), nodeId.coordinator]);
  });
  nodes.push(
    make(nodeId.coordinator, "coordinator", COLUMN.coordinator, MID, {
      label: "Coordinator",
      sub: "",
    }),
  );
  rows(workers.length, 1.15, 2.6).forEach((y, i) => {
    const slot = workers[i]!;
    nodes.push(
      make(nodeId.worker(slot.id), "worker", COLUMN.worker, y, {
        label: slot.workerType ? WORKER_LABEL[slot.workerType] : "Worker",
        sub: slot.id,
        ...(slot.workerType ? { workerType: slot.workerType } : {}),
      }),
    );
    edges.push([nodeId.coordinator, nodeId.worker(slot.id)]);
  });

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    for (const [du, dv] of [
      [-n.w, -n.d],
      [n.w, -n.d],
      [n.w, n.d],
      [-n.w, n.d],
    ] as const) {
      for (const z of [0, n.h + 70]) {
        const p = project(n.u + du, n.v + dv, z);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  const pad = 60;
  return {
    nodes,
    byId: new Map(nodes.map((n) => [n.id, n])),
    edges,
    viewBox: { x: minX - pad, y: minY - 16, w: maxX - minX + pad * 2, h: maxY - minY + 60 },
  };
};

/** Painter's order: blocks further back are drawn first. */
export const depthOrder = (nodes: ReadonlyArray<MapNode>): MapNode[] =>
  [...nodes].sort((a, b) => a.u + a.v - (b.u + b.v));

/** Where a packet is `t` (0..1) of the way from `a` to `b`: on the rail, lifted, with a hop. */
export const packetAt = (a: MapNode, b: MapNode, t: number): { at: Point; floor: Point } => {
  const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const u = a.u + (b.u - a.u) * e;
  const v = a.v + (b.v - a.v) * e;
  const floor = project(u, v);
  return { floor, at: { x: floor.x, y: floor.y - PACKET_LIFT - Math.sin(Math.PI * e) * 18 } };
};

/** SVG points for one face of a block. */
export const face = (n: MapNode, which: "top" | "left" | "right"): string => {
  const P = (du: number, dv: number, z: number) => {
    const p = project(n.u + du, n.v + dv, z);
    return `${p.x},${p.y}`;
  };
  const { w, d, h } = n;
  if (which === "top") return [P(-w, -d, h), P(w, -d, h), P(w, d, h), P(-w, d, h)].join(" ");
  if (which === "left") return [P(-w, d, 0), P(w, d, 0), P(w, d, h), P(-w, d, h)].join(" ");
  return [P(w, -d, 0), P(w, d, 0), P(w, d, h), P(w, -d, h)].join(" ");
};

/** SVG transform that lays flat content onto the floor plane at a point. */
export const onTop = (p: Point, scale = 1): string =>
  `matrix(${0.866 * scale} ${0.5 * scale} ${-0.866 * scale} ${0.5 * scale} ${p.x} ${p.y})`;

/** SVG transform that draws flat content on a block's front-left face, running along `u`. */
export const onLeftFace = (p: Point): string => `matrix(0.866 0.5 0 1 ${p.x} ${p.y})`;

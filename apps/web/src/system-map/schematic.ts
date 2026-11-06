import type { MapNode, NodeKind, Point } from "./iso.ts";

/** Flat schematic geometry: cards on a dot grid joined by S-curves, laid out like a flow chart. */
const COLUMN_PX = 190;
const ROW_PX = 165;
const ORIGIN: Point = { x: 70, y: 70 };

const SIZE: Readonly<Record<NodeKind, readonly [number, number]>> = {
  channel: [112, 44],
  adapter: [164, 66],
  coordinator: [256, 150],
  worker: [200, 86],
};

export interface Box {
  /** Centre. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const boxOf = (n: MapNode): Box => {
  const [w, h] = SIZE[n.kind];
  return { x: ORIGIN.x + n.x * COLUMN_PX, y: ORIGIN.y + n.y * ROW_PX, w, h };
};

/** A cubic Bézier from the right edge of the left card to the left edge of the right card. */
export interface Curve {
  readonly p0: Point;
  readonly p1: Point;
  readonly p2: Point;
  readonly p3: Point;
}

export const curveBetween = (a: MapNode, b: MapNode): Curve => {
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  const l = boxOf(left);
  const r = boxOf(right);
  const x0 = l.x + l.w / 2;
  const x3 = r.x - r.w / 2;
  const mid = (x0 + x3) / 2;
  return {
    p0: { x: x0, y: l.y },
    p1: { x: mid, y: l.y },
    p2: { x: mid, y: r.y },
    p3: { x: x3, y: r.y },
  };
};

export const pathOf = ({ p0, p1, p2, p3 }: Curve): string =>
  `M${p0.x} ${p0.y} C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`;

/** Where a packet is `t` (0..1) of the way from `a` to `b`, eased, in either direction. */
export const packetOnCurve = (a: MapNode, b: MapNode, t: number): Point => {
  const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const s = a.x <= b.x ? eased : 1 - eased;
  const { p0, p1, p2, p3 } = curveBetween(a, b);
  const k = 1 - s;
  const at = (q0: number, q1: number, q2: number, q3: number) =>
    k * k * k * q0 + 3 * k * k * s * q1 + 3 * k * s * s * q2 + s * s * s * q3;
  return { x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) };
};

/** Room under the Coordinator card for tickets waiting to be pulled. */
const QUEUE_ROOM = 44;

export const schematicViewBox = (nodes: ReadonlyArray<MapNode>) => {
  const boxes = nodes.map(boxOf);
  const minX = Math.min(...boxes.map((b) => b.x - b.w / 2)) - 24;
  const maxX = Math.max(...boxes.map((b) => b.x + b.w / 2)) + 24;
  const minY = Math.min(...boxes.map((b) => b.y - b.h / 2)) - 24;
  const maxY = Math.max(...boxes.map((b) => b.y + b.h / 2)) + QUEUE_ROOM;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

import { describe, expect, it } from "vite-plus/test";
import { layout } from "./iso.ts";
import { boxOf, curveBetween, packetOnCurve, pathOf, schematicViewBox } from "./schematic.ts";

const map = layout(
  ["discord", "email"],
  [
    { id: "w1", workerType: "local" },
    { id: "w2", workerType: "daytona_pi" },
  ],
);
const node = (id: string) => map.byId.get(id)!;

describe("schematic geometry", () => {
  it("lays cards out in columns, left to right", () => {
    const xs = ["channel:discord", "adapter:discord", "coordinator", "worker:w1"].map(
      (id) => boxOf(node(id)).x,
    );
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(boxOf(node("worker:w1")).y).toBeLessThan(boxOf(node("worker:w2")).y);
  });

  it("joins the right edge of the left card to the left edge of the right card, either way round", () => {
    const a = node("adapter:discord");
    const c = node("coordinator");
    const curve = curveBetween(a, c);
    expect(curve.p0.x).toBe(boxOf(a).x + boxOf(a).w / 2);
    expect(curve.p3.x).toBe(boxOf(c).x - boxOf(c).w / 2);
    expect(curveBetween(c, a)).toEqual(curve);
    expect(pathOf(curve)).toMatch(/^M[\d.]+ [\d.]+ C/);
  });

  it("moves packets along the curve in the direction of travel", () => {
    const a = node("adapter:email");
    const c = node("coordinator");
    const { p0, p3 } = curveBetween(a, c);
    expect(packetOnCurve(a, c, 0)).toEqual(p0);
    expect(packetOnCurve(a, c, 1)).toEqual(p3);
    expect(packetOnCurve(c, a, 0)).toEqual(p3);
    expect(packetOnCurve(a, c, 0.25).x).toBeLessThan(packetOnCurve(a, c, 0.75).x);
  });

  it("fits every card, with room under the Coordinator for waiting tickets", () => {
    const box = schematicViewBox(map.nodes);
    for (const n of map.nodes) {
      const b = boxOf(n);
      expect(b.x - b.w / 2).toBeGreaterThan(box.x);
      expect(b.x + b.w / 2).toBeLessThan(box.x + box.w);
      expect(b.y + b.h / 2).toBeLessThan(box.y + box.h);
    }
    const coord = boxOf(node("coordinator"));
    expect(box.y + box.h - (coord.y + coord.h / 2)).toBeGreaterThanOrEqual(40);
  });
});

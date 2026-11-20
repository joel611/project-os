import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { depthOrder, face, layout, nodeId, onLeftFace, onTop, packetAt, project } from "./iso.ts";

describe("layout", () => {
  it("places channels, adapters, the Coordinator and each Worker, wired left to right", () => {
    const map = layout(
      ["discord", "email"],
      [
        { id: "w1", workerType: "local" },
        { id: "w2", workerType: "daytona_pi" },
      ],
    );
    expect(map.nodes.map((n) => n.id)).toEqual([
      "channel:discord",
      "adapter:discord",
      "channel:email",
      "adapter:email",
      "coordinator",
      "worker:w1",
      "worker:w2",
    ]);
    expect(map.edges).toContainEqual([nodeId.coordinator, nodeId.worker("w2")]);
    const x = (id: string) => project(map.byId.get(id)!.u, map.byId.get(id)!.v).x;
    expect(x("channel:discord")).toBeLessThan(x("adapter:discord"));
    expect(x("adapter:discord")).toBeLessThan(x("coordinator"));
    expect(x("coordinator")).toBeLessThan(x("worker:w1"));
  });

  it("fits every block inside the view box", () => {
    const map = layout(
      ["discord"],
      Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, workerType: null })),
    );
    for (const n of map.nodes) {
      const p = project(n.u, n.v, n.h);
      expect(p.x).toBeGreaterThan(map.viewBox.x);
      expect(p.x).toBeLessThan(map.viewBox.x + map.viewBox.w);
      expect(p.y).toBeGreaterThan(map.viewBox.y);
    }
  });

  it("draws blocks further back first", () => {
    const map = layout(["discord", "email"], []);
    const order = depthOrder(map.nodes).map((n) => n.id);
    expect(order.indexOf("adapter:discord")).toBeLessThan(order.indexOf("adapter:email"));
  });
});

describe("layout properties", () => {
  const channels = fc.subarray(["discord", "email", "chat"] as const);
  const workers = fc
    .uniqueArray(fc.stringMatching(/^[a-z0-9]{1,6}$/), { maxLength: 12 })
    .map((ids) => ids.map((id) => ({ id, workerType: null })));

  it("emits one block per channel, adapter, Worker and the Coordinator, all with unique ids", () => {
    fc.assert(
      fc.property(channels, workers, (c, w) => {
        const map = layout(c, w);
        const ids = map.nodes.map((n) => n.id);
        expect(ids).toHaveLength(c.length * 2 + w.length + 1);
        expect(new Set(ids).size).toBe(ids.length);
      }),
    );
  });

  it("only draws edges between blocks that exist", () => {
    fc.assert(
      fc.property(channels, workers, (c, w) => {
        const map = layout(c, w);
        for (const [from, to] of map.edges) {
          expect(map.byId.has(from)).toBe(true);
          expect(map.byId.has(to)).toBe(true);
        }
      }),
    );
  });

  it("keeps every block inside the view box however many Workers there are", () => {
    fc.assert(
      fc.property(channels, workers, (c, w) => {
        const map = layout(c, w);
        for (const n of map.nodes) {
          const p = project(n.u, n.v, n.h);
          expect(p.x).toBeGreaterThan(map.viewBox.x);
          expect(p.x).toBeLessThan(map.viewBox.x + map.viewBox.w);
          expect(p.y).toBeGreaterThan(map.viewBox.y);
        }
      }),
    );
  });

  it("orders blocks back to front", () => {
    fc.assert(
      fc.property(channels, workers, (c, w) => {
        const depth = depthOrder(layout(c, w).nodes).map((n) => n.u + n.v);
        expect(depth).toEqual([...depth].sort((a, b) => a - b));
      }),
    );
  });

  it("starts a packet on its source block and ends it on its target", () => {
    fc.assert(
      fc.property(channels, workers, fc.nat(), fc.nat(), (c, w, i, j) => {
        const { nodes } = layout(c, w);
        const a = nodes[i % nodes.length]!;
        const b = nodes[j % nodes.length]!;
        expect(packetAt(a, b, 0).floor.x).toBeCloseTo(project(a.u, a.v).x);
        expect(packetAt(a, b, 1).floor.y).toBeCloseTo(project(b.u, b.v).y);
      }),
    );
  });
});

describe("drawing helpers", () => {
  const map = layout(["discord"], [{ id: "w1", workerType: "local" }]);
  const a = map.byId.get("adapter:discord")!;
  const b = map.byId.get("coordinator")!;

  it("moves a packet from one block to the next, highest in the middle", () => {
    const start = packetAt(a, b, 0);
    const quarter = packetAt(a, b, 0.25);
    const middle = packetAt(a, b, 0.5);
    const end = packetAt(a, b, 1);
    expect(start.floor).toEqual(project(a.u, a.v));
    expect(end.floor.x).toBeCloseTo(project(b.u, b.v).x);
    expect(quarter.floor.x).toBeGreaterThan(start.floor.x);
    expect(middle.floor.y - middle.at.y).toBeGreaterThan(start.floor.y - start.at.y);
    expect(packetAt(a, b, 0.75).floor.x).toBeLessThan(end.floor.x);
  });

  it("draws the three visible faces of a block as four points each", () => {
    for (const side of ["top", "left", "right"] as const)
      expect(face(b, side).split(" ")).toHaveLength(4);
    expect(face(b, "top")).not.toBe(face(b, "left"));
  });

  it("builds the floor and face transforms", () => {
    expect(onTop({ x: 1, y: 2 })).toBe("matrix(0.866 0.5 -0.866 0.5 1 2)");
    expect(onTop({ x: 0, y: 0 }, 2)).toBe("matrix(1.732 1 -1.732 1 0 0)");
    expect(onLeftFace({ x: 3, y: 4 })).toBe("matrix(0.866 0.5 0 1 3 4)");
  });
});

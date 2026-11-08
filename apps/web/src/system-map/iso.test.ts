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

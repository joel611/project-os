import { describe, expect, it } from "vitest";

import { getRouter } from "../router";

describe("router", () => {
  it("builds a router with a route tree", () => {
    const router = getRouter();

    expect(router.routeTree.id).toBe("__root__");
  });
});

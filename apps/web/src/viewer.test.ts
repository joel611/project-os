import { describe, expect, it } from "vite-plus/test";
import { memberMayVisit } from "./viewer.ts";

describe("memberMayVisit", () => {
  it("keeps a member to My tickets and its ticket sheets", () => {
    expect(memberMayVisit("/mine")).toBe(true);
    expect(memberMayVisit("/mine/tickets/t1")).toBe(true);
    expect(memberMayVisit("/")).toBe(false);
    expect(memberMayVisit("/projects/p1")).toBe(false);
    expect(memberMayVisit("/minefield")).toBe(false);
  });
});

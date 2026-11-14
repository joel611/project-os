// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { api } from "./api.ts";
import { memberMayVisit, useViewer } from "./viewer.ts";

describe("memberMayVisit", () => {
  it("keeps a member to My tickets and its ticket pages", () => {
    expect(memberMayVisit("/mine")).toBe(true);
    expect(memberMayVisit("/mine/tickets/t1")).toBe(true);
    expect(memberMayVisit("/")).toBe(false);
    expect(memberMayVisit("/projects/p1")).toBe(false);
    expect(memberMayVisit("/minefield")).toBe(false);
  });
});

describe("useViewer", () => {
  it("asks the Coordinator who is signed in", async () => {
    const viewer = { role: "member", name: "Ada", person: null } as const;
    vi.spyOn(api, "me").mockResolvedValue(viewer);
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useViewer(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(viewer));
    client.clear();
  });
});

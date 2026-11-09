// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { session, sessionExpired } from "./session.ts";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("keeps the token across reloads, until cleared", () => {
  expect(session.token()).toBeNull();
  session.save("tok-1");
  expect(session.token()).toBe("tok-1");
  expect(localStorage.getItem("project-os.token")).toBe("tok-1");
  session.clear();
  expect(session.token()).toBeNull();
});

it("forgets an expired token and goes to the login page once, however many calls 401", () => {
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  session.save("stale");
  sessionExpired();
  sessionExpired();
  expect(session.token()).toBeNull();
  expect(assign).toHaveBeenCalledOnce();
  expect(assign).toHaveBeenCalledWith("/login");
});

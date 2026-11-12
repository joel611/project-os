// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { applyTheme, readTheme, resolveTheme, THEME_BOOT, useTheme } from "./theme.ts";

const prefersDark = (dark: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: dark && q === "(prefers-color-scheme: dark)",
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

/** A media query whose OS setting the test can flip, counting its live listeners. */
const liveMedia = (initial: boolean) => {
  const listeners = new Set<() => void>();
  const media = {
    matches: initial,
    addEventListener: (_: string, f: () => void) => listeners.add(f),
    removeEventListener: (_: string, f: () => void) => listeners.delete(f),
  };
  vi.stubGlobal("matchMedia", () => media);
  return {
    listeners,
    flip: (dark: boolean) => {
      media.matches = dark;
      for (const f of listeners) f();
    },
  };
};

const isDark = () => document.documentElement.classList.contains("dark");

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.className = "";
});

it("defaults to following the system, and remembers an explicit choice", () => {
  expect(readTheme()).toBe("system");
  localStorage.setItem("project-os.theme", "dark");
  expect(readTheme()).toBe("dark");
  localStorage.setItem("project-os.theme", "neon");
  expect(readTheme()).toBe("system");
});

it("resolves system to the OS setting and keeps explicit choices", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});

it("toggles the dark class that the CSS tokens key on", () => {
  prefersDark(true);
  applyTheme("system");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  applyTheme("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

it("boot script agrees with applyTheme before React loads", () => {
  for (const [stored, osDark, want] of [
    [null, true, true],
    [null, false, false],
    ["light", true, false],
    ["dark", false, true],
  ] as const) {
    prefersDark(osDark);
    if (stored) localStorage.setItem("project-os.theme", stored);
    else localStorage.removeItem("project-os.theme");
    document.documentElement.className = "";
    new Function(THEME_BOOT)();
    expect(document.documentElement.classList.contains("dark")).toBe(want);
  }
});

it("falls back to the system theme when storage is blocked", () => {
  const blocked = () => {
    throw new Error("blocked");
  };
  vi.stubGlobal("localStorage", { getItem: blocked, clear: () => {} });
  expect(readTheme()).toBe("system");
});

it("treats a browser without matchMedia as light", () => {
  vi.stubGlobal("matchMedia", undefined);
  applyTheme("system");
  expect(isDark()).toBe(false);
  const { result, unmount } = renderHook(() => useTheme());
  expect(result.current[0]).toBe("system");
  unmount();
});

it("follows the OS while on system, and stops once a theme is picked", () => {
  const os = liveMedia(false);
  const { result, unmount } = renderHook(() => useTheme());
  expect(isDark()).toBe(false);
  act(() => os.flip(true));
  expect(isDark()).toBe(true);

  act(() => result.current[1]("light"));
  expect(result.current[0]).toBe("light");
  expect(localStorage.getItem("project-os.theme")).toBe("light");
  expect(isDark()).toBe(false);
  expect(os.listeners.size).toBe(0);

  act(() => result.current[1]("system"));
  expect(localStorage.getItem("project-os.theme")).toBeNull();
  expect(isDark()).toBe(true);
  unmount();
  expect(os.listeners.size).toBe(0);
});

it("keeps a choice for the visit when storage is blocked", () => {
  liveMedia(false);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const { result, unmount } = renderHook(() => useTheme());
  act(() => result.current[1]("dark"));
  expect(result.current[0]).toBe("dark");
  expect(isDark()).toBe(true);
  unmount();
});

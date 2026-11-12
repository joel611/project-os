// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { applyTheme, readTheme, resolveTheme, THEME_BOOT } from "./theme.ts";

const prefersDark = (dark: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: dark && q === "(prefers-color-scheme: dark)",
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
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

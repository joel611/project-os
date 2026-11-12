import { useEffect, useState } from "react";

/** The operator's choice; "system" follows the OS setting as it changes. */
export type ThemePref = "light" | "dark" | "system";

const KEY = "project-os.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export const readTheme = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};

export const resolveTheme = (pref: ThemePref, systemDark: boolean): "light" | "dark" =>
  pref === "system" ? (systemDark ? "dark" : "light") : pref;

const systemDark = () => globalThis.matchMedia?.(DARK_QUERY).matches ?? false;

export const applyTheme = (pref: ThemePref): void => {
  const dark = resolveTheme(pref, systemDark()) === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
};

/**
 * Runs in <head> before first paint, so a dark-mode reload never flashes light. Kept in step
 * with readTheme/applyTheme above by the theme test.
 */
export const THEME_BOOT = `(function(){try{var p=localStorage.getItem("${KEY}");var d=p==="dark"||(p!=="light"&&matchMedia("${DARK_QUERY}").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}catch(e){}})()`;

export const useTheme = () => {
  const [pref, setPref] = useState<ThemePref>(readTheme);

  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system") return;
    const media = globalThis.matchMedia?.(DARK_QUERY);
    const follow = () => applyTheme("system");
    media?.addEventListener("change", follow);
    return () => media?.removeEventListener("change", follow);
  }, [pref]);

  const choose = (next: ThemePref) => {
    setPref(next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  };

  return [pref, choose] as const;
};

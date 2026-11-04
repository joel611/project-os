import { createContext, useContext, useSyncExternalStore } from "react";
import { makeApi, type Api } from "@/api";
import { parseRoute } from "@/model";

export const ApiContext = createContext<Api>(makeApi());
export const useApi = () => useContext(ApiContext);

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** The current hash route; re-renders on navigation. */
export const useRoute = () =>
  parseRoute(useSyncExternalStore(subscribe, () => window.location.hash));

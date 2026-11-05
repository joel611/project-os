import { useEffect, useState } from "react";

const TICK_MS = 15_000;

/**
 * The current time, refreshed every 15s. Relative times ("3m ago") need this: a poll that returns
 * unchanged data does not re-render, so `new Date()` at render time would freeze.
 */
export const useNow = (): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
};

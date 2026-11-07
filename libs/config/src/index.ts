// Env parsing shared by apps. Each app reads only the keys it needs.

export const env = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`Missing env var ${key}`);
  return value;
};

export const envNumber = (key: string, fallback?: number): number =>
  Number(env(key, fallback === undefined ? undefined : String(fallback)));

/** `true`/`1`/`yes`/`on` (any case) are true, anything else false; unset uses `fallback`. */
export const envBool = (key: string, fallback: boolean): boolean => {
  const value = process.env[key];
  return value === undefined ? fallback : /^(true|1|yes|on)$/i.test(value.trim());
};

export * from "./health.ts";

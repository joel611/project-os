// Env parsing shared by apps. Each app reads only the keys it needs.

/** Where keys are read from. Default: `process.env`. */
type Source = Readonly<Record<string, string | undefined>>;

export const env = (key: string, fallback?: string, source: Source = process.env): string => {
  const value = source[key] ?? fallback;
  if (value === undefined) throw new Error(`Missing env var ${key}`);
  return value;
};

export const envNumber = (key: string, fallback?: number, source: Source = process.env): number =>
  Number(env(key, fallback === undefined ? undefined : String(fallback), source));

/** `true`/`1`/`yes`/`on` (any case) are true, anything else false; unset uses `fallback`. */
export const envBool = (key: string, fallback: boolean, source: Source = process.env): boolean => {
  const value = source[key];
  return value === undefined ? fallback : /^(true|1|yes|on)$/i.test(value.trim());
};

export * from "./health.ts";

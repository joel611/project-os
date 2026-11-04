// Env parsing shared by apps. Each app reads only the keys it needs.
export const env = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`Missing env var ${key}`);
  return value;
};

export const envNumber = (key: string, fallback?: number): number =>
  Number(env(key, fallback === undefined ? undefined : String(fallback)));

export * from "./health.ts";

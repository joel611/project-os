import { Effect } from "effect";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A random URL-safe secret. Web Crypto: works on Bun and Workers alike. */
export const randomSecret = (bytes: number): Effect.Effect<string> =>
  Effect.sync(() => base64url(crypto.getRandomValues(new Uint8Array(bytes))));

/** Hex SHA-256: what the Coordinator stores in place of codes and device secrets. */
export const sha256Hex = (value: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  });

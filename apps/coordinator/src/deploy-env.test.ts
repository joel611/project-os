import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  notBound,
  optionalSecrets,
  optionalVars,
  requiredSecrets,
  setByStack,
  vars,
} from "./deploy-env.ts";
import { entriesOf } from "../../../scripts/gh-env.ts";

const root = resolve(import.meta.dirname, "../../..");

/** The Coordinator and the env parsing it calls. Packages take settings as arguments. */
const sources = ["apps/coordinator/src", "libs/config/src"].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    // Not part of a running Coordinator: tests, manual scripts, the seed script, this list.
    .filter((file) => !/\.(test|smoke)\.ts$|^main\.seed\.ts$|^deploy-env\.ts$/.test(file))
    .map((file) => readFileSync(join(root, dir, file), "utf8")),
);

const matches = (pattern: RegExp) =>
  sources.flatMap((source) => [...source.matchAll(pattern)].map((match) => match[1]!));

/**
 * Settings the source names: `env.NAME` / `source.NAME`, any `"SOME_NAME"` string (how
 * `envBool`, `nonEmpty` and friends are called) and `oauthClient`'s prefixed pairs.
 */
const read = new Set([
  ...matches(/\b(?:env|source)\.([A-Z][A-Z0-9_]*)\b/g),
  ...matches(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g),
  ...matches(/\benv(?:Number|Bool)?\("([A-Z]+)"/g),
  ...matches(/\boauthClient\(env, "([A-Z]+)"\)/g).flatMap((prefix) => [
    `${prefix}_CLIENT_ID`,
    `${prefix}_CLIENT_SECRET`,
  ]),
]);

const secrets: ReadonlyArray<string> = [...requiredSecrets, ...optionalSecrets];
const forwarded: ReadonlyArray<string> = [...Object.keys(vars), ...optionalVars, ...secrets];
const bound = new Set<string>([...forwarded, ...setByStack]);

describe("deploy settings", () => {
  it("binds every setting the Coordinator reads, or says why not", () => {
    expect([...read].filter((key) => !bound.has(key) && !(key in notBound)).sort()).toEqual([]);
  });

  it("excuses only settings that are read and not bound", () => {
    expect(Object.keys(notBound).filter((key) => !read.has(key) || bound.has(key))).toEqual([]);
  });

  it("is forwarded by the deploy workflow", () => {
    const workflow = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
    expect(
      forwarded.filter((key) => !new RegExp(`^\\s+${key}: \\$\\{\\{`, "m").test(workflow)),
    ).toEqual([]);
  });

  it("is uploaded to GitHub as a secret when the deploy binds it as one", () => {
    const upload = entriesOf(secrets.map((key) => `${key}=x`).join("\n"));
    expect(upload.filter((entry) => entry.kind !== "secret").map((entry) => entry.key)).toEqual([]);
  });
});

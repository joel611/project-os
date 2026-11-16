import { DrizzleSqlite } from "@project-os/db-sqlite";
import { Layer, ManagedRuntime } from "effect";
import type { AuthConfig } from "./auth.ts";
import { Auth } from "./service.ts";

/** `Auth.layer` over an already-open test database. */
export const layerOf = ({ db, ...settings }: AuthConfig) =>
  Auth.layer(settings).pipe(Layer.provide(DrizzleSqlite.from(db)));

/** An `Auth` built through its layer, for tests that want the instance directly. */
export const authOf = (config: AuthConfig) => ManagedRuntime.make(layerOf(config)).runSync(Auth);

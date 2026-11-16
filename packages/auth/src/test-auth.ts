import { ManagedRuntime } from "effect";
import type { AuthConfig } from "./auth.ts";
import { Auth } from "./service.ts";

/** An `Auth` built through its layer, for tests that want the instance directly. */
export const authOf = (config: AuthConfig) => ManagedRuntime.make(Auth.layer(config)).runSync(Auth);

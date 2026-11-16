// Explicit on purpose: `makeAuth` stays inside the package, so an instance can only be built
// through `Auth.layer` (or `Auth.from`).
export type {
  AdminAccount,
  AuthApi,
  AuthConfig,
  GoogleSignIn,
  OAuthClientConfig,
  SessionUser,
} from "./auth.ts";
export { SIGN_IN_DONE_PATH } from "./auth.ts";
export type { Connections, LinkStart } from "./connections.ts";
export { CONNECT_DONE_PATH, emailFor } from "./connections.ts";
export { Auth } from "./service.ts";

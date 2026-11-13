import type { Access } from "./access.ts";

/** An Access that takes every caller for an Operator, for tests of the routes alone. */
export const OPERATOR: Access = {
  caller: async () => ({ kind: "user", userId: "u-op", name: "Op" }),
  personOf: async () => undefined,
};

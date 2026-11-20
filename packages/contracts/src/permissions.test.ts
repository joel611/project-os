import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  allows,
  can,
  isRole,
  PERMISSION_STATEMENTS,
  ROLE_GRANTS,
  ROLES,
  type Resource,
} from "./permissions.ts";

describe("role permissions", () => {
  it("grants an admin every action on every resource", () => {
    for (const [resource, actions] of Object.entries(PERMISSION_STATEMENTS)) {
      for (const action of actions) {
        expect(allows(ROLE_GRANTS.admin, resource as never, action as never)).toBe(true);
      }
    }
  });

  it("lets a member read only the tickets they are involved in", () => {
    expect(can("member", "ticket", "read-own")).toBe(true);
    expect(can("member", "ticket", "read")).toBe(false);
    expect(can("member", "ticket", "update")).toBe(false);
    expect(can("member", "project", "read")).toBe(false);
    expect(can("member", "audit", "read")).toBe(false);
    expect(can("member", "member", "update")).toBe(false);
  });

  it("reads grants the Coordinator sent, and treats a missing resource as no access", () => {
    expect(allows({ ticket: ["read-own"] }, "ticket", "read-own")).toBe(true);
    expect(allows({ ticket: ["read-own"] }, "project", "read")).toBe(false);
  });

  it("knows its roles", () => {
    expect(ROLES.every(isRole)).toBe(true);
    expect(isRole("owner")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  describe("properties", () => {
    const resource = fc.constantFrom(...(Object.keys(PERMISSION_STATEMENTS) as Resource[]));
    const anyAction = fc.constantFrom(
      ...new Set(Object.values(PERMISSION_STATEMENTS).flatMap((a) => [...a])),
    );

    it("never lets a member do anything an admin cannot", () => {
      fc.assert(
        fc.property(resource, anyAction, (r, a) => {
          if (can("member", r, a as never)) expect(can("admin", r, a as never)).toBe(true);
        }),
      );
    });

    it("denies every resource and action the grants do not list", () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (r, a) => {
          expect(allows({}, r as never, a as never)).toBe(false);
        }),
      );
    });

    it("allows exactly the listed actions", () => {
      fc.assert(
        fc.property(fc.array(fc.string()), fc.string(), (listed, probe) => {
          expect(allows({ ticket: listed }, "ticket", probe as never)).toBe(listed.includes(probe));
        }),
      );
    });

    it("accepts a string as a role only when it is one of ROLES", () => {
      fc.assert(
        fc.property(fc.anything(), (v) => {
          expect(isRole(v)).toBe(typeof v === "string" && (ROLES as readonly string[]).includes(v));
        }),
      );
    });
  });
});

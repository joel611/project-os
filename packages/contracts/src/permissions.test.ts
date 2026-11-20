import { describe, expect, it } from "vite-plus/test";
import { allows, can, isRole, PERMISSION_STATEMENTS, ROLE_GRANTS, ROLES } from "./permissions.ts";

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
});

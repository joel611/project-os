import { describe, expect, it } from "vite-plus/test";
import { isAllowedMember, memberRoleIds, parseIds } from "./members.ts";

describe("parseIds", () => {
  it("is undefined (no gate) when unset or blank", () => {
    expect(parseIds(undefined)).toBeUndefined();
    expect(parseIds("")).toBeUndefined();
    expect(parseIds(" , ")).toBeUndefined();
  });

  it("splits and trims a comma-separated list", () => {
    expect([...parseIds(" r1, r2 ,,r3")!]).toEqual(["r1", "r2", "r3"]);
  });
});

describe("memberRoleIds", () => {
  it("reads a GuildMember's role cache", () => {
    const member = {
      roles: {
        cache: new Map([
          ["r1", {}],
          ["r2", {}],
        ]),
      },
    };
    expect(memberRoleIds(member)).toEqual(["r1", "r2"]);
  });

  it("reads a raw API member's role array", () => {
    expect(memberRoleIds({ roles: ["r1"] })).toEqual(["r1"]);
  });

  it("has no roles without a member (DMs) or roles", () => {
    expect(memberRoleIds(null)).toEqual([]);
    expect(memberRoleIds(undefined)).toEqual([]);
    expect(memberRoleIds({ displayName: "Joel" })).toEqual([]);
    expect(memberRoleIds({ roles: null })).toEqual([]);
    expect(memberRoleIds({ roles: { cache: "not a map" } })).toEqual([]);
  });
});

describe("isAllowedMember", () => {
  const gate = { roleIds: parseIds("member,staff"), adminUserIds: parseIds("admin1") };

  it("lets everyone through without a gate", () => {
    expect(isAllowedMember("u1", null, { roleIds: undefined })).toBe(true);
  });

  it("allows a member holding any allowed role", () => {
    expect(isAllowedMember("u1", { roles: ["guest", "staff"] }, gate)).toBe(true);
    expect(isAllowedMember("u1", { roles: { cache: new Map([["member", {}]]) } }, gate)).toBe(true);
  });

  it("refuses members without an allowed role, and DMs", () => {
    expect(isAllowedMember("u1", { roles: ["guest"] }, gate)).toBe(false);
    expect(isAllowedMember("u1", null, gate)).toBe(false);
  });

  it("always lets admins through, even without a member role", () => {
    expect(isAllowedMember("admin1", { roles: ["guest"] }, gate)).toBe(true);
    expect(isAllowedMember("admin1", null, gate)).toBe(true);
  });

  it("checks roles when no admin list is given", () => {
    expect(isAllowedMember("admin1", null, { roleIds: gate.roleIds })).toBe(false);
  });
});

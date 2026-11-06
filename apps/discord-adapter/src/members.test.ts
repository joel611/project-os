import { describe, expect, it } from "vite-plus/test";
import { isAllowedMember, memberRoleIds, parseRoleIds } from "./members.ts";

describe("parseRoleIds", () => {
  it("is undefined (no gate) when unset or blank", () => {
    expect(parseRoleIds(undefined)).toBeUndefined();
    expect(parseRoleIds("")).toBeUndefined();
    expect(parseRoleIds(" , ")).toBeUndefined();
  });

  it("splits and trims a comma-separated list", () => {
    expect([...parseRoleIds(" r1, r2 ,,r3")!]).toEqual(["r1", "r2", "r3"]);
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
  });
});

describe("isAllowedMember", () => {
  const gate = parseRoleIds("member,staff");

  it("lets everyone through without a gate", () => {
    expect(isAllowedMember(null, undefined)).toBe(true);
  });

  it("allows a member holding any allowed role", () => {
    expect(isAllowedMember({ roles: ["guest", "staff"] }, gate)).toBe(true);
    expect(isAllowedMember({ roles: { cache: new Map([["member", {}]]) } }, gate)).toBe(true);
  });

  it("refuses members without an allowed role, and DMs", () => {
    expect(isAllowedMember({ roles: ["guest"] }, gate)).toBe(false);
    expect(isAllowedMember(null, gate)).toBe(false);
  });
});

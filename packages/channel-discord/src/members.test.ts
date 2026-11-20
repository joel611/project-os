import fc from "fast-check";
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

  it("returns exactly the ids it was given, ignoring spacing and empty entries", () => {
    const id = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);
    fc.assert(
      fc.property(fc.array(id, { minLength: 1 }), fc.constantFrom("", " ", "  "), (ids, pad) => {
        const parsed = parseIds(ids.map((i) => `${pad}${i}${pad}`).join(",") + ",,");
        expect([...parsed!].sort()).toEqual([...new Set(ids)].sort());
      }),
    );
  });

  it("applies no gate when the list holds only separators and blanks", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ ,]*$/), (raw) => {
        expect(parseIds(raw)).toBeUndefined();
      }),
    );
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

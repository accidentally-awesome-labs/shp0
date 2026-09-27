import { describe, it, expect } from "vitest";

import {
  ROLES,
  ROLE_LABEL,
  CAPABILITY_MINIMUM_ROLE,
  parseRole,
  roleRank,
  hasAtLeastRole,
  isCapability,
  minimumRole,
  can,
} from "../src/roles";
import type { Capability, Role } from "../src/roles";

/**
 * Role policy for dashboard authorization (CONTEXT.md: Role, Owner, Admin,
 * Staff).
 *
 * Roles are ranked Owner > Admin > Staff, and a Role has its own capabilities
 * plus every lower Role's, so authorization is a rank comparison against a
 * capability's minimum Role. Anything that is not exactly one of the three
 * stored role strings grants nothing (fail closed): memberships.role is free
 * text with no CHECK constraint, and a mis-cased "Owner" escapes the
 * single-Owner index and the owner-delete trigger.
 *
 * Pure: no database.
 */

const EXPECTED_MINIMUM_ROLE: Record<Capability, Role> = {
  // Staff: view the catalog, Orders and Customers, and fulfill Orders.
  "store.view": "staff",
  "catalog.view": "staff",
  "discounts.view": "staff",
  "customers.view": "staff",
  "orders.view": "staff",
  "orders.fulfill": "staff",
  // Admin: manage the catalog and Discounts, and Store settings (payouts, Custom Domains).
  "catalog.manage": "admin",
  "discounts.manage": "admin",
  "settings.manage": "admin",
  "domains.manage": "admin",
  // Owner: platform billing (viewing too: an owner decision), Memberships, transfer/delete.
  "billing.view": "owner",
  "billing.manage": "owner",
  "memberships.manage": "owner",
  "store.transfer": "owner",
  "store.delete": "owner",
};

const CAPABILITIES = Object.keys(EXPECTED_MINIMUM_ROLE) as Capability[];

describe("parseRole", () => {
  it.each(["owner", "admin", "staff"] as const)("accepts the stored role %s", (role) => {
    expect(parseRole(role)).toBe(role);
  });

  it.each([
    ["mis-cased Owner", "Owner"],
    ["upper case", "ADMIN"],
    ["leading space", " staff"],
    ["trailing space", "owner "],
    ["trailing newline", "owner\n"],
    ["empty", ""],
    ["unknown text", "garbage"],
    ["a different role name", "manager"],
    ["prototype key __proto__", "__proto__"],
    ["prototype key toString", "toString"],
    ["prototype key constructor", "constructor"],
  ])("fails closed on %s", (_label, raw) => {
    expect(parseRole(raw)).toBe(null);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 3],
    ["a boolean", true],
    ["an object", { role: "owner" }],
    ["an array", ["owner"]],
  ])("fails closed on %s", (_label, raw) => {
    expect(parseRole(raw)).toBe(null);
  });
});

describe("rank", () => {
  it("lists the Roles highest first", () => {
    expect(ROLES).toEqual(["owner", "admin", "staff"]);
  });

  it("ranks Owner above Admin above Staff, and no Role below all of them", () => {
    expect(roleRank("owner")).toBeGreaterThan(roleRank("admin"));
    expect(roleRank("admin")).toBeGreaterThan(roleRank("staff"));
    expect(roleRank("staff")).toBeGreaterThan(roleRank(null));
    expect(roleRank(null)).toBe(0);
  });

  it("gives unknown role text no rank", () => {
    expect(roleRank("Owner")).toBe(0);
    expect(roleRank("garbage")).toBe(0);
    expect(roleRank(undefined)).toBe(0);
  });

  it.each([
    ["owner", "owner", true],
    ["owner", "admin", true],
    ["owner", "staff", true],
    ["admin", "owner", false],
    ["admin", "admin", true],
    ["admin", "staff", true],
    ["staff", "owner", false],
    ["staff", "admin", false],
    ["staff", "staff", true],
  ] as const)("%s has at least %s: %s", (role, minimum, expected) => {
    expect(hasAtLeastRole(role, minimum)).toBe(expected);
  });

  it.each(["Owner", "garbage", "", null, undefined])(
    "role %j has no Role at all, not even Staff",
    (role) => {
      for (const minimum of ROLES) expect(hasAtLeastRole(role, minimum)).toBe(false);
    },
  );

  it("has a display label for every Role", () => {
    expect(ROLE_LABEL).toEqual({ owner: "Owner", admin: "Admin", staff: "Staff" });
  });
});

describe("capability map", () => {
  it("covers exactly the decided capabilities, each at its decided minimum Role", () => {
    expect({ ...CAPABILITY_MINIMUM_ROLE }).toEqual(EXPECTED_MINIMUM_ROLE);
  });

  it("maps every capability to a real Role", () => {
    for (const capability of CAPABILITIES) {
      expect(ROLES).toContain(minimumRole(capability));
    }
  });

  it("reserves viewing platform billing to the Owner (owner decision, CONTEXT.md is silent)", () => {
    expect(minimumRole("billing.view")).toBe("owner");
    expect(can("admin", "billing.view")).toBe(false);
  });

  it("recognizes only its own capability names", () => {
    for (const capability of CAPABILITIES) expect(isCapability(capability)).toBe(true);
    for (const other of ["catalog", "CATALOG.VIEW", "", "__proto__", "toString", "constructor", 1, null]) {
      expect(isCapability(other)).toBe(false);
    }
  });
});

describe("can", () => {
  describe.each(CAPABILITIES)("%s", (capability) => {
    const minimum = EXPECTED_MINIMUM_ROLE[capability];

    it.each(ROLES)(`role %s is allowed only at or above ${minimum}`, (role) => {
      expect(can(role, capability)).toBe(roleRank(role) >= roleRank(minimum));
    });

    it.each(["Owner", "ADMIN", "garbage", "", null, undefined, 1])(
      "role %j is never allowed",
      (role) => {
        expect(can(role, capability)).toBe(false);
      },
    );
  });

  it("gives Staff exactly the Staff capabilities", () => {
    expect(CAPABILITIES.filter((c) => can("staff", c)).sort()).toEqual(
      [
        "catalog.view",
        "customers.view",
        "discounts.view",
        "orders.fulfill",
        "orders.view",
        "store.view",
      ],
    );
  });

  it("gives Admin the Staff capabilities plus the Admin ones, and no Owner capability", () => {
    expect(CAPABILITIES.filter((c) => can("admin", c)).sort()).toEqual(
      [
        "catalog.manage",
        "catalog.view",
        "customers.view",
        "discounts.manage",
        "discounts.view",
        "domains.manage",
        "orders.fulfill",
        "orders.view",
        "settings.manage",
        "store.view",
      ],
    );
  });

  it("gives the Owner every capability", () => {
    expect(CAPABILITIES.filter((c) => can("owner", c))).toEqual(CAPABILITIES);
  });

  it.each(["catalog", "billing", "", "__proto__", "toString", "constructor", "hasOwnProperty", null, undefined])(
    "an unknown capability %j is allowed to nobody, not even the Owner",
    (capability) => {
      for (const role of ROLES) expect(can(role, capability as Capability)).toBe(false);
    },
  );
});

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
  decideStoreAccess,
  effectiveRole,
} from "../src/roles";
import type { Capability, Role } from "../src/roles";

/**
 * Role policy for dashboard authorization (CONTEXT.md: Role, Owner, Admin,
 * Staff).
 *
 * Roles are ranked Owner > Admin > Staff, and a Role has its own capabilities
 * plus every lower Role's, so authorization is a rank comparison against a
 * capability's minimum Role. Anything that is not exactly one of the three
 * stored role strings grants nothing (fail closed). The database refuses any
 * other role text and a second Membership for one person in one Store
 * (memberships_role_check, memberships_user_store_key); failing closed here
 * as well is defense in depth.
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

describe("effectiveRole (every Membership row of one person in one Store)", () => {
  it("is null with no row: no Membership", () => {
    expect(effectiveRole([])).toBe(null);
  });

  it.each(["owner", "admin", "staff"] as const)("is the Role of a single %s row", (role) => {
    expect(effectiveRole([role])).toBe(role);
  });

  it.each([
    [["admin", "staff"], "staff"],
    [["staff", "admin"], "staff"],
    [["owner", "admin"], "admin"],
    [["owner", "staff", "admin"], "staff"],
    [["admin", "admin"], "admin"],
  ] as const)("with several rows %j, grants only the lowest Role (%s)", (rows, expected) => {
    expect(effectiveRole(rows)).toBe(expected);
  });

  it.each([
    [["Owner"]],
    [["garbage"]],
    [[""]],
    [["admin", "garbage"]],
    [["garbage", "owner"]],
    [["owner", "Owner"]],
    [["staff", null]],
  ])("fails closed on %j: one row that is not a Role means no Role", (rows) => {
    expect(effectiveRole(rows)).toBe(null);
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

/**
 * The dashboard gate's decision (apps/web/lib/current-store.ts does only the
 * I/O around it: the session, the Membership Role lookup, then throw,
 * notFound(), redirect or render). Actions throw one generic error for every
 * status but "ok"; pages redirect "unauthenticated", show "not_member" the
 * not-found page and name the required Role for "insufficient_role".
 */
describe("decideStoreAccess", () => {
  it("is unauthenticated without a session, whatever the Role", () => {
    for (const role of [...ROLES, null, "garbage"]) {
      expect(decideStoreAccess(false, role, "catalog.view")).toEqual({ status: "unauthenticated" });
    }
  });

  it.each([null, undefined, "Owner", "ADMIN", " staff", "garbage", "", 3, {}])(
    "treats role %j as no Membership (a missing Store reads the same)",
    (role) => {
      for (const capability of CAPABILITIES) {
        expect(decideStoreAccess(true, role, capability)).toEqual({ status: "not_member" });
      }
    },
  );

  describe.each(CAPABILITIES)("%s", (capability) => {
    const minimum = EXPECTED_MINIMUM_ROLE[capability];
    it.each(ROLES)(`role %s is ok at or above ${minimum}, else insufficient`, (role) => {
      const decision = decideStoreAccess(true, role, capability);
      if (roleRank(role) >= roleRank(minimum)) {
        expect(decision).toEqual({ status: "ok", role });
      } else {
        expect(decision).toEqual({ status: "insufficient_role", role, required: minimum });
      }
    });
  });

  it("matches the brief's examples", () => {
    expect(decideStoreAccess(true, "staff", "catalog.manage")).toEqual({
      status: "insufficient_role",
      role: "staff",
      required: "admin",
    });
    expect(decideStoreAccess(true, "admin", "billing.view")).toEqual({
      status: "insufficient_role",
      role: "admin",
      required: "owner",
    });
    expect(decideStoreAccess(true, "owner", "billing.manage")).toEqual({ status: "ok", role: "owner" });
    expect(decideStoreAccess(true, "staff", "customers.view")).toEqual({ status: "ok", role: "staff" });
  });

  it.each(["catalog", "", "__proto__", "toString", null])(
    "refuses an unknown capability %j by throwing, even for the Owner",
    (capability) => {
      expect(() => decideStoreAccess(true, "owner", capability as Capability)).toThrow(/^Unknown capability/);
      expect(() => decideStoreAccess(false, null, capability as Capability)).toThrow(/^Unknown capability/);
    },
  );
});

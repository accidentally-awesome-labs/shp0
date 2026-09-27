import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { BASE_URL, urlWithSearchPath } from "./scoped-schema";

/**
 * getMembershipRole on a database that memberships_user_store_key and
 * memberships_role_check have not reached: one an older applySchema()
 * created, where applySchema() has not run since.
 *
 * The shared test database refuses several Memberships for one person in one
 * Store and role text other than exactly owner/admin/staff
 * (membership-constraints.test.ts), so it can no longer hold these rows.
 * getMembershipRole still reads every row and fails closed on them, as
 * defense in depth. The rule itself (effectiveRole) is unit tested in
 * roles.test.ts; this file checks that getMembershipRole really hands it
 * every row, not just one.
 *
 * The database here is a throwaway schema (./scoped-schema), bootstrapped by
 * applySchema() and then stripped of the two constraints. The platform pool
 * reads PLATFORM_DATABASE_URL when ../src/index is first imported, so that
 * is pointed at the schema before the import (vitest gives each test file
 * its own module graph) and restored afterwards.
 */

const SCHEMA = `unconstrained_${randomUUID().replace(/-/g, "")}`;
const SCOPED_URL = urlWithSearchPath(BASE_URL, SCHEMA);
const STORE = randomUUID();

/**
 * Each person's Memberships in STORE, in insertion order. A read of only the
 * first row or only the last row gets the "between" cases wrong.
 */
const MEMBERSHIPS: Record<string, string[]> = {
  staff: ["staff"],
  adminThenStaff: ["admin", "staff"],
  staffBetweenAdmins: ["admin", "staff", "admin"],
  adminAndGarbage: ["admin", "garbage"],
  garbageBetweenAdmins: ["admin", "garbage", "admin"],
  ownerAndMisCasedOwner: ["owner", "Owner"],
  misCasedOwner: ["Owner"],
  empty: [""],
};

describe("getMembershipRole on a database without the Membership constraints", () => {
  const previousUrl = process.env.PLATFORM_DATABASE_URL;
  let admin: Pool;
  let scoped: Pool;
  let db: typeof import("../src/index");

  beforeAll(async () => {
    admin = new Pool({ connectionString: BASE_URL });
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    process.env.PLATFORM_DATABASE_URL = SCOPED_URL;
    db = await import("../src/index");

    await db.applySchema(SCOPED_URL);
    scoped = new Pool({ connectionString: SCOPED_URL });
    await scoped.query(`
      ALTER TABLE memberships
        DROP CONSTRAINT memberships_user_store_key,
        DROP CONSTRAINT memberships_role_check`);
    await scoped.query(
      `INSERT INTO stores (id, store_id, name, subdomain)
       VALUES ($1, $1, 'Unconstrained', 'unconstrained')`,
      [STORE],
    );
    for (const [userId, roles] of Object.entries(MEMBERSHIPS)) {
      await scoped.query(
        `INSERT INTO "user" (id, name, email) VALUES ($1, $1, $1 || '@unconstrained.test')`,
        [userId],
      );
      for (const role of roles) {
        await scoped.query(
          "INSERT INTO memberships (user_id, store_id, role) VALUES ($1, $2, $3)",
          [userId, STORE, role],
        );
      }
    }
  });

  afterAll(async () => {
    await db?.closePools();
    await scoped?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin?.end();
    if (previousUrl === undefined) delete process.env.PLATFORM_DATABASE_URL;
    else process.env.PLATFORM_DATABASE_URL = previousUrl;
  });

  it("reads this schema: a person with one valid row has that Role", async () => {
    // "staff" and STORE exist only in this schema, so this also shows the
    // platform pool is not reading `public`.
    expect(await db.getMembershipRole("staff", STORE)).toBe("staff");
  });

  it.each(["adminThenStaff", "staffBetweenAdmins"])(
    "with several Memberships in one Store (%s), grants only the lowest Role",
    async (userId) => {
      expect(await db.getMembershipRole(userId, STORE)).toBe("staff");
    },
  );

  it.each([
    "adminAndGarbage",
    "garbageBetweenAdmins",
    "ownerAndMisCasedOwner",
    "misCasedOwner",
    "empty",
  ])("fails closed when any of the person's rows is not a Role (%s): null", async (userId) => {
    expect(await db.getMembershipRole(userId, STORE)).toBe(null);
  });

  it("authorizeStoreMembership (boolean) agrees", async () => {
    expect(await db.authorizeStoreMembership("adminThenStaff", STORE)).toBe(true);
    expect(await db.authorizeStoreMembership("garbageBetweenAdmins", STORE)).toBe(false);
    expect(await db.authorizeStoreMembership("misCasedOwner", STORE)).toBe(false);
  });
});

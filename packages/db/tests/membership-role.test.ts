import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  provisionStore,
  getMembershipRole,
  authorizeStoreMembership,
} from "../src/index";

/**
 * The caller's Role in a Store, for dashboard authorization.
 *
 * getMembershipRole is the database half of the Role check: the web layer
 * compares what it returns against a capability's minimum Role
 * (src/roles.ts). It must fail closed: no Membership, a Store that does not
 * exist and a malformed Store id all return null, which grants nothing.
 *
 * Role text other than exactly owner/admin/staff, and several Memberships
 * for one person in one Store, can no longer be stored
 * (membership-constraints.test.ts). The read still fails closed on them as
 * defense in depth; that rule, effectiveRole, is unit tested in
 * roles.test.ts.
 */
describe("getMembershipRole", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  const users: Record<string, string> = {};
  let storeId: string;
  let otherStoreId: string;

  async function addMembership(userId: string, role: string, store = storeId): Promise<void> {
    await db.execute(
      sql`INSERT INTO memberships (user_id, store_id, role) VALUES (${userId}, ${store}, ${role})`,
    );
  }

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );

    for (const name of ["owner", "admin", "staff", "outsider"]) {
      users[name] = randomUUID();
      await db.execute(
        sql`INSERT INTO "user" (id, name, email) VALUES (${users[name]}, ${name}, ${`${name}@role.test`})`,
      );
    }

    storeId = (await provisionStore({ name: "Roles", subdomain: "roles-test", ownerId: users.owner! }))
      .store.id;
    otherStoreId = (
      await provisionStore({ name: "Other", subdomain: "roles-other", ownerId: users.outsider! })
    ).store.id;

    await addMembership(users.admin!, "admin");
    await addMembership(users.staff!, "staff");
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  it.each(["owner", "admin", "staff"] as const)("returns the %s Role", async (role) => {
    expect(await getMembershipRole(users[role]!, storeId)).toBe(role);
  });

  it("returns null for a Merchant with no Membership in the Store", async () => {
    expect(await getMembershipRole(users.outsider!, storeId)).toBe(null);
    // ...who does hold a Membership elsewhere: Memberships are per Store.
    expect(await getMembershipRole(users.outsider!, otherStoreId)).toBe("owner");
    expect(await getMembershipRole(users.owner!, otherStoreId)).toBe(null);
  });

  it("returns null for a Store that does not exist, like a non-member", async () => {
    expect(await getMembershipRole(users.owner!, randomUUID())).toBe(null);
  });

  it.each([
    ["not a uuid", "not-a-uuid"],
    ["empty", ""],
    ["a SQL fragment", "' OR 1=1 --"],
  ])("returns null without querying for a malformed Store id (%s)", async (_label, bad) => {
    expect(await getMembershipRole(users.owner!, bad)).toBe(null);
  });

  it("returns null for an unknown or missing user id", async () => {
    expect(await getMembershipRole(randomUUID(), storeId)).toBe(null);
    expect(await getMembershipRole("", storeId)).toBe(null);
  });

  it("authorizeStoreMembership (boolean) agrees: true only with a Role in that Store", async () => {
    expect(await authorizeStoreMembership(users.staff!, storeId)).toBe(true);
    expect(await authorizeStoreMembership(users.outsider!, storeId)).toBe(false);
    expect(await authorizeStoreMembership(users.owner!, "not-a-uuid")).toBe(false);
  });
});

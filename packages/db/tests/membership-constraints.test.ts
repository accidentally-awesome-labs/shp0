import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { applySchema, closePools, provisionStore, getMembershipRole } from "../src/index";

/**
 * The database itself holds one Membership per person per Store, with role
 * text that is exactly "owner", "admin" or "staff" (CONTEXT.md: Membership,
 * Role).
 *
 * Without these constraints the same person and Store accepted rows
 * {owner, garbage, staff}, and a mis-cased "Owner" escaped the single-Owner
 * index and the owner-delete trigger (both match role = 'owner' exactly).
 *
 * Statements go through node-postgres directly so each rejection can be
 * checked by SQLSTATE and constraint name: 23505 is unique_violation, 23514
 * is check_violation.
 */
describe("memberships: one Membership per person per Store, valid Role text", () => {
  let pool: Pool;
  const users: Record<string, string> = {};
  let storeId: string;
  let otherStoreId: string;

  async function insertMembership(userId: string, role: string, store = storeId) {
    return pool.query(
      "INSERT INTO memberships (user_id, store_id, role) VALUES ($1, $2, $3)",
      [userId, store, role],
    );
  }

  /** A new Merchant (user) with no Membership anywhere. */
  async function newUser(): Promise<string> {
    const person = randomUUID();
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'x', $2)`, [
      person,
      `${person}@constraints.test`,
    ]);
    return person;
  }

  async function rolesOf(userId: string, store = storeId): Promise<string[]> {
    const { rows } = await pool.query<{ role: string }>(
      "SELECT role FROM memberships WHERE user_id = $1 AND store_id = $2 ORDER BY role",
      [userId, store],
    );
    return rows.map((r) => r.role);
  }

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    await pool.query(
      `TRUNCATE memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );
    for (const name of ["owner", "admin", "staff", "newcomer"]) {
      users[name] = randomUUID();
      await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
        users[name],
        name,
        `${name}@constraints.test`,
      ]);
    }
    storeId = (
      await provisionStore({ name: "Constraints", subdomain: "constraints", ownerId: users.owner! })
    ).store.id;
    otherStoreId = (
      await provisionStore({ name: "Second", subdomain: "constraints-2", ownerId: users.owner! })
    ).store.id;
    await insertMembership(users.admin!, "admin");
    await insertMembership(users.staff!, "staff");
  });

  afterAll(async () => {
    await pool?.end();
    await closePools();
  });

  it("provisionStore still makes the creator the Owner, once per Store, in each Store they create", async () => {
    expect(await rolesOf(users.owner!)).toEqual(["owner"]);
    expect(await rolesOf(users.owner!, otherStoreId)).toEqual(["owner"]);
    expect(await getMembershipRole(users.owner!, storeId)).toBe("owner");
    expect(await getMembershipRole(users.owner!, otherStoreId)).toBe("owner");
  });

  it.each(["owner", "admin", "staff"])(
    "refuses a second Membership for the same person and Store (%s): unique violation",
    async (role) => {
      await expect(insertMembership(users.staff!, role)).rejects.toMatchObject({
        code: "23505",
        constraint: "memberships_user_store_key",
      });
      expect(await rolesOf(users.staff!)).toEqual(["staff"]);
    },
  );

  it("refuses a second Membership for the Owner in their own Store, whatever the Role", async () => {
    for (const role of ["admin", "staff"]) {
      await expect(insertMembership(users.owner!, role)).rejects.toMatchObject({
        code: "23505",
        constraint: "memberships_user_store_key",
      });
    }
    expect(await rolesOf(users.owner!)).toEqual(["owner"]);
  });

  it("refuses an UPDATE that would give a person a second Membership in a Store", async () => {
    await insertMembership(users.admin!, "staff", otherStoreId);
    await expect(
      pool.query("UPDATE memberships SET store_id = $1 WHERE user_id = $2 AND store_id = $3", [
        storeId,
        users.admin!,
        otherStoreId,
      ]),
    ).rejects.toMatchObject({ code: "23505", constraint: "memberships_user_store_key" });
    expect(await rolesOf(users.admin!)).toEqual(["admin"]);
    expect(await rolesOf(users.admin!, otherStoreId)).toEqual(["staff"]);
  });

  it("still lets one person hold Memberships in many Stores", async () => {
    await insertMembership(users.newcomer!, "staff", storeId);
    await insertMembership(users.newcomer!, "admin", otherStoreId);
    expect(await getMembershipRole(users.newcomer!, storeId)).toBe("staff");
    expect(await getMembershipRole(users.newcomer!, otherStoreId)).toBe("admin");
  });

  it.each([
    ["mis-cased 'Owner'", "Owner"],
    ["upper case 'OWNER'", "OWNER"],
    ["mis-cased 'Admin'", "Admin"],
    ["'garbage'", "garbage"],
    ["the empty string", ""],
    ["a leading space", " staff"],
    ["a trailing space", "admin "],
  ])("refuses role text %s: check violation", async (_label, role) => {
    const person = await newUser();
    await expect(insertMembership(person, role)).rejects.toMatchObject({
      code: "23514",
      constraint: "memberships_role_check",
    });
    expect(await rolesOf(person)).toEqual([]);
  });

  it("refuses an UPDATE to role text that is not a Role", async () => {
    await expect(
      pool.query("UPDATE memberships SET role = 'Admin' WHERE user_id = $1 AND store_id = $2", [
        users.staff!,
        storeId,
      ]),
    ).rejects.toMatchObject({ code: "23514", constraint: "memberships_role_check" });
    expect(await rolesOf(users.staff!)).toEqual(["staff"]);
  });

  it("the single-Owner index cannot be bypassed by case", async () => {
    // A second Owner spelled exactly is refused by the partial unique index...
    await expect(insertMembership(await newUser(), "owner")).rejects.toMatchObject({
      code: "23505",
      constraint: "memberships_one_owner_per_store",
    });
    // ...and spelled any other way it is not a Role at all.
    for (const role of ["Owner", "OWNER", "owner "]) {
      await expect(insertMembership(await newUser(), role)).rejects.toMatchObject({
        code: "23514",
        constraint: "memberships_role_check",
      });
    }
    // Promoting an Admin by case is refused too.
    await expect(
      pool.query("UPDATE memberships SET role = 'Owner' WHERE user_id = $1 AND store_id = $2", [
        users.admin!,
        storeId,
      ]),
    ).rejects.toMatchObject({ code: "23514", constraint: "memberships_role_check" });

    const owners = await pool.query(
      "SELECT user_id FROM memberships WHERE store_id = $1 AND lower(btrim(role)) = 'owner'",
      [storeId],
    );
    expect(owners.rows).toEqual([{ user_id: users.owner! }]);
  });

  it("the Owner row cannot be renamed out from under the owner-delete trigger", async () => {
    // With free role text, 'owner' -> 'Owner' and then DELETE removed the Owner.
    await expect(
      pool.query(
        "UPDATE memberships SET role = 'Owner' WHERE user_id = $1 AND store_id = $2 AND role = 'owner'",
        [users.owner!, storeId],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "memberships_role_check" });
    await expect(
      pool.query("DELETE FROM memberships WHERE user_id = $1 AND store_id = $2", [
        users.owner!,
        storeId,
      ]),
    ).rejects.toThrow(/Cannot delete an owner Membership/);
    expect(await rolesOf(users.owner!)).toEqual(["owner"]);
  });
});

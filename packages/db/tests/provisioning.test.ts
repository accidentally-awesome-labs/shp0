import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  provisionStore,
  listMemberships,
  checkSubdomainAvailable,
} from "../src/index";

/**
 * Issue #4 — Store provisioning + Owner Membership.
 */
describe("Store provisioning + Owner Membership (Issue #4)", () => {
  let pool: Pool;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({
      connectionString: "postgresql:///shp0_test?user=cloud_admin",
    });
    const db = drizzle(pool);
    // Clean up for hermeticity.
    await db.execute(
      sql`TRUNCATE memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );
    // Seed two Merchants (global users).
    userA = randomUUID();
    userB = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${userA}, 'Alice', 'alice@example.com'), (${userB}, 'Bob', 'bob@example.com')`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  // ── Cycle 1: tracer bullet ──────────────────────────────────────────
  it("provisions a Store and makes the creator its Owner, atomically", async () => {
    const { store } = await provisionStore({
      name: "Acme",
      subdomain: "acme",
      ownerId: userA,
    });

    expect(store.name).toBe("Acme");
    expect(store.subdomain).toBe("acme");
    expect(store.id).toBeTruthy();
    expect(store.storeId).toBe(store.id);

    // The creator is the Owner.
    const db = drizzle(pool);
    const memberships = await db.execute(
      sql`SELECT role FROM memberships WHERE user_id = ${userA} AND store_id = ${store.id}`,
    );
    expect(memberships.rows).toHaveLength(1);
    expect(memberships.rows[0]!.role).toBe("owner");
  });

  // ── Cycle 2: subdomain uniqueness ───────────────────────────────────
  it("rejects a duplicate subdomain", async () => {
    await expect(
      provisionStore({ name: "Imposter", subdomain: "acme", ownerId: userB }),
    ).rejects.toThrow();
  });

  // ── Cycle 3: single-Owner invariant ─────────────────────────────────
  it("enforces exactly one Owner per Store — cannot add a second, cannot delete the Owner", async () => {
    const { store } = await provisionStore({
      name: "Beta",
      subdomain: "beta",
      ownerId: userA,
    });

    // Cannot add a second Owner (partial unique index rejects it).
    const db = drizzle(pool);
    await expect(
      db.execute(
        sql`INSERT INTO memberships (user_id, store_id, role) VALUES (${userB}, ${store.id}, 'owner')`,
      ),
    ).rejects.toThrow();

    // Can add a Staff member (not owner).
    await db.execute(
      sql`INSERT INTO memberships (user_id, store_id, role) VALUES (${userB}, ${store.id}, 'staff')`,
    );

    // Cannot delete the Owner Membership (trigger rejects it).
    await expect(
      db.execute(
        sql`DELETE FROM memberships WHERE user_id = ${userA} AND store_id = ${store.id} AND role = 'owner'`,
      ),
    ).rejects.toThrow();

    // Can delete the Staff member (trigger allows non-owner deletes).
    await db.execute(
      sql`DELETE FROM memberships WHERE user_id = ${userB} AND store_id = ${store.id} AND role = 'staff'`,
    );
  });

  // ── Cycle 4: store switcher ─────────────────────────────────────────
  it("lists all Stores a Merchant belongs to (switcher data)", async () => {
    const memberships = await listMemberships(userA);
    // userA is owner of Acme + Beta (provisioned above).
    expect(memberships).toHaveLength(2);
    const subdomains = memberships.map((m) => m.subdomain).sort();
    expect(subdomains).toEqual(["acme", "beta"]);
    expect(memberships.every((m) => m.role === "owner")).toBe(true);
  });

  it("checks subdomain availability", async () => {
    expect(await checkSubdomainAvailable("acme")).toBe(false); // taken
    expect(await checkSubdomainAvailable("totally-free")).toBe(true); // available
  });
});

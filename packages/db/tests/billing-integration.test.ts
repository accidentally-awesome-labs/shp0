import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  provisionStore,
  getStoreTier,
  setStoreTier,
} from "../src/index";
import { TIERS } from "../src/billing";

/**
 * Issue #15 — Tier switching. No Tier carries a Commission (ADR-0007).
 */
describe("Platform billing — tiers (Issue #15)", () => {
  let pool: Pool;
  let storeId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE subscriptions, addresses, customer_sessions, customers, discount_redemptions, discounts, collection_products, collections, cart_items, carts, order_lines, orders, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );

    const user = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${user}, 'Bill', 'bill@example.com')`,
    );
    const s = await provisionStore({ name: "BillStore", subdomain: "bill-store", ownerId: user });
    storeId = s.store.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  it("defaults to the Free tier (no subscription yet)", async () => {
    expect(await getStoreTier(storeId)).toEqual(TIERS.free);
  });

  it("upgrades to Pro, then Scale, and downgrades back to Free", async () => {
    await setStoreTier(storeId, "pro");
    expect(await getStoreTier(storeId)).toEqual(TIERS.pro);
    await setStoreTier(storeId, "scale");
    expect(await getStoreTier(storeId)).toEqual(TIERS.scale);
    await setStoreTier(storeId, "free");
    expect(await getStoreTier(storeId)).toEqual(TIERS.free);
  });

  it("keeps no Commission rate on a Store (ADR-0007)", async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'stores' AND column_name = 'commission_bps'`,
    );
    expect(rows).toEqual([]);
  });

  // A tier id reaches setStoreTier from a form field. An unknown one used to
  // be stored as is, after which getStoreTier returned undefined and the
  // billing page crashed.
  it.each(["bogus", "enterprise-free", "", "Pro", "__proto__", "constructor", "toString"])(
    "rejects the unknown tier id %j and leaves the Subscription unchanged",
    async (tierId) => {
      await setStoreTier(storeId, "pro");
      await expect(setStoreTier(storeId, tierId as "free")).rejects.toThrow("Unknown tier");
      const tier = await getStoreTier(storeId);
      expect(tier.id).toBe("pro");
    },
  );
});

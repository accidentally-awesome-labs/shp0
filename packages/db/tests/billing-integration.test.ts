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
  getTierCommissionBps,
  setStoreTier,
} from "../src/index";
import { TIERS } from "../src/billing";

/**
 * Issue #15 — Tier switching + commission rate application.
 */
describe("Platform billing — tier + commission (Issue #15)", () => {
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
    const tier = await getStoreTier(storeId);
    expect(tier.id).toBe("free");
    expect(tier.commissionBps).toBe(TIERS.free.commissionBps);
  });

  it("commission rate reflects the Free tier (300 bps = 3.0%)", async () => {
    const bps = await getTierCommissionBps(storeId);
    expect(bps).toBe(300);
  });

  it("upgrades to Pro — commission rate drops to 200 bps", async () => {
    await setStoreTier(storeId, "pro");
    const tier = await getStoreTier(storeId);
    expect(tier.id).toBe("pro");
    expect(tier.commissionBps).toBe(200);
    expect(await getTierCommissionBps(storeId)).toBe(200);
  });

  it("upgrades to Scale — commission rate drops to 100 bps", async () => {
    await setStoreTier(storeId, "scale");
    expect(await getTierCommissionBps(storeId)).toBe(100);
  });

  it("downgrades back to Free — commission rate returns to 300 bps", async () => {
    await setStoreTier(storeId, "free");
    expect(await getTierCommissionBps(storeId)).toBe(300);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  provisionStore,
  listAllStoresForOperator,
  getPlatformAnalytics,
  applyStoreStatusAction,
} from "../src/index";

/**
 * Issue #16 — Platform admin: cross-Store operator view + suspend/terminate.
 *
 * All reads go through platformClient (cross-Store). The store status state
 * machine enforces the two-step protection (suspend before terminate).
 */
describe("Platform admin (Issue #16)", () => {
  let pool: Pool;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE subscriptions, addresses, customer_sessions, customers, discount_redemptions, discounts, collection_products, collections, cart_items, carts, order_lines, orders, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );

    const userA = randomUUID();
    const userB = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${userA}, 'Owner A', 'a@example.com'), (${userB}, 'Owner B', 'b@example.com')`,
    );
    const a = await provisionStore({ name: "Store A", subdomain: "store-a", ownerId: userA });
    storeAId = a.store.id;
    const b = await provisionStore({ name: "Store B", subdomain: "store-b", ownerId: userB });
    storeBId = b.store.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  // ── Cross-Store store listing ──
  it("lists all stores with their owners (cross-Store via platformClient)", async () => {
    const stores = await listAllStoresForOperator();
    expect(stores).toHaveLength(2);
    const names = stores.map((s) => s.name).sort();
    expect(names).toEqual(["Store A", "Store B"]);
    // Each store has an owner linked.
    expect(stores.every((s) => s.ownerEmail !== null)).toBe(true);
  });

  // ── Platform analytics ──
  it("provides platform analytics (store counts + GMV)", async () => {
    const analytics = await getPlatformAnalytics();
    expect(analytics.totalStores).toBe(2);
    expect(analytics.activeStores).toBe(2);
    expect(analytics.suspendedStores).toBe(0);
    expect(analytics.gmvCents).toBe(0); // no paid orders yet
  });

  // ── Suspend a store ──
  it("suspends a store (active → suspended)", async () => {
    const result = await applyStoreStatusAction(storeAId, "suspend");
    expect(result).toEqual({ ok: true });

    const stores = await listAllStoresForOperator();
    const storeA = stores.find((s) => s.id === storeAId)!;
    expect(storeA.status).toBe("suspended");
  });

  // ── Block direct terminate from active ──
  it("blocks terminating Store B directly (must suspend first)", async () => {
    const result = await applyStoreStatusAction(storeBId, "terminate");
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });

    // Store B stays active.
    const stores = await listAllStoresForOperator();
    const storeB = stores.find((s) => s.id === storeBId)!;
    expect(storeB.status).toBe("active");
  });

  // ── Terminate after suspending ──
  it("terminates a suspended store (suspended → terminated)", async () => {
    // Suspend first, then terminate.
    await applyStoreStatusAction(storeBId, "suspend");
    const result = await applyStoreStatusAction(storeBId, "terminate");
    expect(result).toEqual({ ok: true });

    const stores = await listAllStoresForOperator();
    const storeB = stores.find((s) => s.id === storeBId)!;
    expect(storeB.status).toBe("terminated");

    // Analytics reflect the changes.
    const analytics = await getPlatformAnalytics();
    expect(analytics.activeStores).toBe(0);
    expect(analytics.suspendedStores).toBe(1); // Store A
    expect(analytics.terminatedStores).toBe(1); // Store B
  });

  // ── Reinstate a suspended store ──
  it("reinstates a suspended store (suspended → active)", async () => {
    const result = await applyStoreStatusAction(storeAId, "reinstate");
    expect(result).toEqual({ ok: true });

    const stores = await listAllStoresForOperator();
    const storeA = stores.find((s) => s.id === storeAId)!;
    expect(storeA.status).toBe("active");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  provisionStore,
  createDiscount,
  redeemDiscount,
  listDiscounts,
} from "../src/index";
import type { DiscountReward } from "../src/discounts";

/**
 * Issue #12 — Discount redemption: row-locked usage limits + idempotency.
 */
describe("Discount redemption (Issue #12)", () => {
  let pool: Pool;
  let storeId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE discount_redemptions, discounts, collection_products, collections, cart_items, carts, order_lines, orders, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );

    const user = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${user}, 'Disc', 'disc@example.com')`,
    );
    const s = await provisionStore({ name: "DiscStore", subdomain: "disc-store", ownerId: user });
    storeId = s.store.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  it("creates a code-based discount with a usage limit", async () => {
    const reward: DiscountReward = { kind: "order_percent", percent: 20 };
    const { id } = await createDiscount(storeId, {
      name: "SAVE20",
      trigger: { type: "code", code: "SAVE20" },
      reward,
      conditions: { usageLimit: 1 },
    });
    expect(id).toBeDefined();

    const discounts = await listDiscounts(storeId);
    expect(discounts).toHaveLength(1);
    expect(discounts[0]!.usageCount).toBe(0);
  });

  it("redeems a discount (increments usage_count)", async () => {
    const discounts = await listDiscounts(storeId);
    const discountId = discounts[0]!.id;
    const orderId = randomUUID();

    const result = await redeemDiscount(storeId, discountId, orderId);
    expect(result).toEqual({ ok: true });

    const after = await listDiscounts(storeId);
    expect(after[0]!.usageCount).toBe(1);
  });

  it("is idempotent: redeeming the same discount+order again is a no-op", async () => {
    // Create a separate unlimited discount for idempotency testing.
    const reward: DiscountReward = { kind: "order_percent", percent: 10 };
    const { id } = await createDiscount(storeId, {
      name: "IDEMPOTENT",
      trigger: { type: "code", code: "IDEMPOTENT" },
      reward,
    });
    const orderId = randomUUID();

    const r1 = await redeemDiscount(storeId, id, orderId);
    expect(r1).toEqual({ ok: true });

    const r2 = await redeemDiscount(storeId, id, orderId);
    expect(r2).toEqual({ ok: false, reason: "already_redeemed" });

    // Different order → should succeed (no limit).
    const orderId2 = randomUUID();
    const r3 = await redeemDiscount(storeId, id, orderId2);
    expect(r3).toEqual({ ok: true });
  });

  it("enforces usage limits: blocks redemption when limit is reached", async () => {
    // The discount from the first test has usageLimit: 1.
    // It's been redeemed twice (once in each test above), so usage_count = 2 > limit = 1.
    // Wait — the limit is per-discount, not per-test. Let me create a new one.
    const reward: DiscountReward = { kind: "order_fixed", amountCents: 500 };
    const { id } = await createDiscount(storeId, {
      name: "LIMITED",
      trigger: { type: "code", code: "LIMITED" },
      reward,
      conditions: { usageLimit: 1 },
    });

    const order1 = randomUUID();
    const order2 = randomUUID();

    // First redemption succeeds.
    const r1 = await redeemDiscount(storeId, id, order1);
    expect(r1).toEqual({ ok: true });

    // Second redemption (different order) hits the limit.
    const r2 = await redeemDiscount(storeId, id, order2);
    expect(r2).toEqual({ ok: false, reason: "usage_limit_reached" });
  });
});

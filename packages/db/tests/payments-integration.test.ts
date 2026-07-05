import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  provisionStore,
  createProduct,
  getOrCreateDbCart,
  saveDbCartLines,
  checkout,
  markOrderPaid,
  getOrder,
  isEventProcessed,
  markEventProcessed,
  platformClient,
} from "../src/index";
import { variants } from "../src/schema";

/**
 * Issue #10 — Payment transaction: the concurrency fence.
 *
 * markOrderPaid() is the critical correctness boundary:
 * - It decrements inventory under a FOR UPDATE row-lock.
 * - It transitions payment: pending → paid.
 * - If inventory is insufficient, it voids the payment (no oversell).
 * - It's idempotent (replay = no-op).
 */
describe("Payment transaction — markOrderPaid (Issue #10)", () => {
  let pool: Pool;
  let storeId: string;
  let customerId: string;
  let variantId1: string;
  let variantId2: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE processed_events, stripe_payment_accounts, order_lines, orders, cart_items, carts, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );

    const user = randomUUID();
    customerId = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${user}, 'Pay', 'pay@example.com')`,
    );

    const s = await provisionStore({ name: "PayStore", subdomain: "pay-store", ownerId: user });
    storeId = s.store.id;

    await createProduct(storeId, {
      title: "Gadget",
      description: "Test product",
      slug: "gadget",
      variants: [
        { sku: "G-1", title: "Red", priceCents: 1000, inventory: 5 },
        { sku: "G-2", title: "Blue", priceCents: 2000, inventory: 2 },
      ],
    });

    const vRows = await platformClient(async (tx) => {
      return tx.select({ id: variants.id, sku: variants.sku }).from(variants);
    });
    variantId1 = vRows.find((v) => v.sku === "G-1")!.id;
    variantId2 = vRows.find((v) => v.sku === "G-2")!.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  async function createOrder(lines: Array<{ variantId: string; quantity: number }>): Promise<string> {
    await getOrCreateDbCart(storeId, customerId);
    await saveDbCartLines(storeId, customerId, lines);
    const result = await checkout(storeId, customerId);
    return result.orderId;
  }

  async function getInventory(variantId: string): Promise<number> {
    return platformClient(async (tx) => {
      const rows = await tx.execute(
        sql`SELECT inventory FROM variants WHERE id = ${variantId}`,
      );
      return rows.rows[0]!.inventory as number;
    });
  }

  it("decrements inventory and transitions to paid when stock is sufficient", async () => {
    const orderId = await createOrder([{ variantId: variantId1, quantity: 3 }]);
    const result = await markOrderPaid(storeId, orderId);
    expect(result).toEqual({ ok: true });
    expect(await getInventory(variantId1)).toBe(2);
    const order = await getOrder(storeId, orderId);
    expect(order!.paymentStatus).toBe("paid");
  });

  it("rejects payment when inventory is insufficient (NO oversell, NO decrement)", async () => {
    const orderId = await createOrder([{ variantId: variantId2, quantity: 5 }]);
    const result = await markOrderPaid(storeId, orderId);
    expect(result).toEqual({ ok: false, reason: "insufficient_inventory" });
    expect(await getInventory(variantId2)).toBe(2);
    const order = await getOrder(storeId, orderId);
    expect(order!.paymentStatus).toBe("pending");
  });

  it("rejects the WHOLE order if ANY line is insufficient (atomic — no partial decrement)", async () => {
    const orderId = await createOrder([
      { variantId: variantId1, quantity: 1 },
      { variantId: variantId2, quantity: 10 },
    ]);
    const result = await markOrderPaid(storeId, orderId);
    expect(result).toEqual({ ok: false, reason: "insufficient_inventory" });
    expect(await getInventory(variantId1)).toBe(2);
    expect(await getInventory(variantId2)).toBe(2);
    const order = await getOrder(storeId, orderId);
    expect(order!.paymentStatus).toBe("pending");
  });

  it("is idempotent: re-calling markOrderPaid on a paid order returns already_paid", async () => {
    const orderId = await createOrder([{ variantId: variantId1, quantity: 1 }]);
    const invBefore = await getInventory(variantId1);
    const r1 = await markOrderPaid(storeId, orderId);
    expect(r1).toEqual({ ok: true });
    const invAfter = await getInventory(variantId1);
    expect(invAfter).toBe(invBefore - 1);
    const r2 = await markOrderPaid(storeId, orderId);
    expect(r2).toEqual({ ok: false, reason: "already_paid" });
    expect(await getInventory(variantId1)).toBe(invAfter);
  });
});

/**
 * Issue #10 — Idempotency via processed_events table.
 */
describe("Webhook idempotency (Issue #10)", () => {
  afterAll(async () => {
    await closePools();
  });

  it("isEventProcessed returns false for an unseen event", async () => {
    const eventId = `evt_test_${randomUUID()}`;
    expect(await isEventProcessed(eventId)).toBe(false);
  });

  it("markEventProcessed + isEventProcessed makes a replay a no-op", async () => {
    const eventId = `evt_test_${randomUUID()}`;
    expect(await isEventProcessed(eventId)).toBe(false);
    await markEventProcessed(eventId);
    expect(await isEventProcessed(eventId)).toBe(true);
    await markEventProcessed(eventId);
    expect(await isEventProcessed(eventId)).toBe(true);
  });
});

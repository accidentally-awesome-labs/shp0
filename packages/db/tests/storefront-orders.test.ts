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
  deleteProduct,
  changeDbCart,
  checkout,
  getOrder,
  getOrderForCheckout,
  getStorefrontOrder,
} from "../src/index";

/**
 * Who may see or pay for an Order on the storefront.
 *
 * There are no Customer sign-ins in checkout yet: an Order's customer_id is
 * the anonymous cart token (the httpOnly shp0_cart_token cookie) of the Cart
 * it came from. Until guest checkout gets a signed Order-access token, that
 * token is the proof: the storefront reads an Order only together with the
 * token that placed it, compared in the query, so a missing or different
 * token reads exactly like an Order that does not exist. The Order id (it is
 * in the URL, in history and in referrers) is not a secret.
 */
describe("Storefront Order access (the placing cart token)", () => {
  let pool: Pool;
  let storeA: string;
  let storeB: string;
  let tokenA1: string;
  let tokenA2: string;
  let orderA1: string;
  let orderA2: string;
  let orderB: string;
  let goneProduct: string;
  let orderWithGoneVariant: string;

  async function placeOrder(storeId: string, token: string, variantId: string, quantity = 1): Promise<string> {
    const added = await changeDbCart(storeId, token, { kind: "add", variantId, quantity });
    expect(added.ok).toBe(true);
    return (await checkout(storeId, token)).orderId;
  }

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    await drizzle(pool).execute(
      sql`TRUNCATE order_lines, orders, cart_items, carts, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );
    const ua = randomUUID();
    const ub = randomUUID();
    await drizzle(pool).execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${ua}, 'A', 'so-a@example.com'), (${ub}, 'B', 'so-b@example.com')`,
    );
    storeA = (await provisionStore({ name: "Alpha", subdomain: "alpha-so", ownerId: ua })).store.id;
    storeB = (await provisionStore({ name: "Beta", subdomain: "beta-so", ownerId: ub })).store.id;

    const widget = await createProduct(storeA, {
      title: "Widget",
      slug: "widget",
      status: "published",
      variants: [{ sku: "W-L", title: "Large", priceCents: 1000, inventory: 10 }],
    });
    const gone = await createProduct(storeA, {
      title: "Discontinued",
      slug: "discontinued",
      status: "published",
      variants: [{ sku: "D-1", title: "Default", priceCents: 300, inventory: 10 }],
    });
    goneProduct = gone.id;
    const gizmo = await createProduct(storeB, {
      title: "Gizmo",
      slug: "gizmo",
      status: "published",
      variants: [{ sku: "G-1", title: "Default", priceCents: 2000, inventory: 10 }],
    });

    tokenA1 = randomUUID();
    tokenA2 = randomUUID();
    orderA1 = await placeOrder(storeA, tokenA1, widget.variants[0]!.id, 2);
    orderA2 = await placeOrder(storeA, tokenA2, widget.variants[0]!.id);
    orderB = await placeOrder(storeB, tokenA1, gizmo.variants[0]!.id);
    orderWithGoneVariant = await placeOrder(storeA, tokenA2, gone.variants[0]!.id);
    await deleteProduct(storeA, goneProduct);
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  describe("getStorefrontOrder (the storefront Order page)", () => {
    it("returns the Order to the cart token that placed it, with titles instead of Variant ids", async () => {
      expect(await getStorefrontOrder(storeA, orderA1, tokenA1)).toEqual({
        id: orderA1,
        paymentStatus: "pending",
        fulfillmentStatus: "unfulfilled",
        totalCents: 2000,
        lines: [{ productTitle: "Widget", variantTitle: "Large", quantity: 2, unitPriceCents: 1000 }],
        payment: null,
      });
    });

    it("reads as not found for another shopper's token, an unknown token, or no token", async () => {
      expect(await getStorefrontOrder(storeA, orderA1, tokenA2)).toBeNull();
      expect(await getStorefrontOrder(storeA, orderA2, tokenA1)).toBeNull();
      expect(await getStorefrontOrder(storeA, orderA1, randomUUID())).toBeNull();
      expect(await getStorefrontOrder(storeA, orderA1, null)).toBeNull();
      expect(await getStorefrontOrder(storeA, orderA1, undefined)).toBeNull();
      expect(await getStorefrontOrder(storeA, orderA1, "")).toBeNull();
    });

    it("reads as not found in another Store, even with the right token", async () => {
      expect(await getStorefrontOrder(storeB, orderA1, tokenA1)).toBeNull();
      expect(await getStorefrontOrder(storeA, orderB, tokenA1)).toBeNull();
      expect(await getStorefrontOrder(storeB, orderB, tokenA1)).toMatchObject({ id: orderB, totalCents: 2000 });
    });

    it("answers malformed ids and tokens with null instead of a database error", async () => {
      expect(await getStorefrontOrder(storeA, "not-a-uuid", tokenA1)).toBeNull();
      expect(await getStorefrontOrder(storeA, `${orderA1}' OR '1'='1`, tokenA1)).toBeNull();
      expect(await getStorefrontOrder(storeA, orderA1, "' OR '1'='1")).toBeNull();
      expect(await getStorefrontOrder(storeA, orderA1, `${tokenA1} `)).toBeNull();
    });

    it("lists lines in Cart order", async () => {
      const token = randomUUID();
      const first = await createProduct(storeA, {
        title: "First",
        slug: "first",
        status: "published",
        variants: [{ sku: "F-1", title: "Default", priceCents: 100, inventory: 10 }],
      });
      const second = await createProduct(storeA, {
        title: "Second",
        slug: "second",
        status: "published",
        variants: [{ sku: "S-1", title: "Default", priceCents: 200, inventory: 10 }],
      });
      const third = await createProduct(storeA, {
        title: "Third",
        slug: "third",
        status: "published",
        variants: [{ sku: "T-1", title: "Default", priceCents: 300, inventory: 10 }],
      });
      for (const p of [third, first, second]) {
        await changeDbCart(storeA, token, { kind: "add", variantId: p.variants[0]!.id, quantity: 1 });
      }
      const { orderId } = await checkout(storeA, token);
      const order = await getStorefrontOrder(storeA, orderId, token);
      expect(order!.lines.map((l) => l.productTitle)).toEqual(["Third", "First", "Second"]);
    });

    it("keeps a line whose Variant was deleted, without a title", async () => {
      const order = await getStorefrontOrder(storeA, orderWithGoneVariant, tokenA2);
      expect(order).toMatchObject({
        totalCents: 300,
        lines: [{ productTitle: null, variantTitle: null, quantity: 1, unitPriceCents: 300 }],
      });
    });
  });

  describe("getOrderForCheckout (Stripe Checkout for a pending Order)", () => {
    it("returns the Order only with the token that placed it", async () => {
      expect(await getOrderForCheckout(storeA, orderA1, tokenA1)).toMatchObject({
        id: orderA1,
        paymentStatus: "pending",
        lines: [{ productTitle: "Widget", quantity: 2 }],
      });
      expect(await getOrderForCheckout(storeA, orderA1, tokenA2)).toBeNull();
      expect(await getOrderForCheckout(storeA, orderA1, randomUUID())).toBeNull();
      expect(await getOrderForCheckout(storeA, orderA1, null)).toBeNull();
      expect(await getOrderForCheckout(storeB, orderA1, tokenA1)).toBeNull();
      expect(await getOrderForCheckout(storeA, "not-a-uuid", tokenA1)).toBeNull();
    });

    it("keeps a deleted Variant's line, so Pay can refuse it and check the total", async () => {
      expect(await getOrderForCheckout(storeA, orderWithGoneVariant, tokenA2)).toEqual({
        id: orderWithGoneVariant,
        paymentStatus: "pending",
        totalCents: 300,
        lines: [
          {
            variantId: expect.any(String),
            productTitle: null,
            variantTitle: null,
            quantity: 1,
            unitPriceCents: 300,
            inventory: null,
          },
        ],
        checkout: { attempt: 0, sessionId: null, inFlight: false },
      });
    });
  });

  describe("getOrder (Store-scoped: Merchant and payment code, never the storefront)", () => {
    it("still reads any Order of its Store, and nothing of another Store", async () => {
      expect(await getOrder(storeA, orderA1)).toMatchObject({ id: orderA1, paymentStatus: "pending" });
      expect(await getOrder(storeA, orderA2)).toMatchObject({ id: orderA2 });
      expect(await getOrder(storeB, orderA1)).toBeNull();
    });

    it("answers a malformed Order id with null instead of a database error", async () => {
      expect(await getOrder(storeA, "not-a-uuid")).toBeNull();
    });
  });
});

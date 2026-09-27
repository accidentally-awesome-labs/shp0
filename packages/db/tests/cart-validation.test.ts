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
  changeDbCart,
  saveDbCartLines,
  getDbCart,
  checkout,
  CheckoutError,
  MAX_LINE_QUANTITY,
} from "../src/index";

/**
 * Cart changes and checkout validate against the Store's live catalog.
 *
 * A Cart holds only Variants of published Products of its own Store, at a
 * whole quantity from 1 to MAX_LINE_QUANTITY. changeDbCart checks a change
 * in the same transaction that writes it (one Store-scoped query under RLS),
 * and checkout re-checks every line, refusing the whole checkout if any is
 * invalid: a Product can be unpublished after it was added, and carts written
 * before this rule may hold anything.
 */
describe("Cart and checkout validation", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let storeA: string;
  let storeB: string;
  let published: string; // Store A, published Product, 1000
  let published2: string; // Store A, published Product, 250
  let draft: string; // Store A, draft Product
  let laterDraftProduct: string; // Store A, published, drafted mid-test
  let laterDraft: string;
  let foreign: string; // Store B, published Product

  async function orderCount(storeId: string, token: string): Promise<number> {
    const rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM orders WHERE store_id = ${storeId} AND customer_id = ${token}`,
    );
    return (rows.rows[0] as { n: number }).n;
  }

  /** The CheckoutError that checkout() must throw for this Cart. */
  async function checkoutError(storeId: string, token: string): Promise<CheckoutError> {
    const outcome = await checkout(storeId, token).then(
      (order) => ({ order }),
      (error: unknown) => ({ error }),
    );
    if ("order" in outcome) {
      throw new Error(
        `checkout should have been refused, but it created Order ${outcome.order.orderId} with total ${outcome.order.totalCents}`,
      );
    }
    expect(outcome.error).toBeInstanceOf(CheckoutError);
    return outcome.error as CheckoutError;
  }

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE order_lines, orders, cart_items, carts, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );
    const ua = randomUUID();
    const ub = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${ua}, 'A', 'cv-a@example.com'), (${ub}, 'B', 'cv-b@example.com')`,
    );
    storeA = (await provisionStore({ name: "Alpha", subdomain: "alpha-cv", ownerId: ua })).store.id;
    storeB = (await provisionStore({ name: "Beta", subdomain: "beta-cv", ownerId: ub })).store.id;

    const variantOf = async (storeId: string, slug: string, status: string, priceCents: number) =>
      (
        await createProduct(storeId, {
          title: slug,
          slug,
          status,
          variants: [{ sku: slug, title: "Default", priceCents, inventory: 100 }],
        })
      ).variants[0]!.id;
    published = await variantOf(storeA, "pub", "published", 1000);
    published2 = await variantOf(storeA, "pub-2", "published", 250);
    draft = await variantOf(storeA, "draft", "draft", 1);
    const later = await createProduct(storeA, {
      title: "later",
      slug: "later",
      status: "published",
      variants: [{ sku: "later", title: "Default", priceCents: 500, inventory: 100 }],
    });
    laterDraftProduct = later.id;
    laterDraft = later.variants[0]!.id;
    foreign = await variantOf(storeB, "foreign", "published", 2000);
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  describe("changeDbCart", () => {
    it("adds a published Variant of the Store, summing repeated adds", async () => {
      const token = randomUUID();
      expect(await changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: 2 })).toMatchObject({ ok: true });
      expect(await changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: 3 })).toMatchObject({ ok: true });
      expect((await getDbCart(storeA, token)).lines).toEqual([{ variantId: published, quantity: 5 }]);
    });

    it("refuses a draft Variant, another Store's Variant and an unknown or malformed id, storing nothing", async () => {
      for (const variantId of [draft, foreign, randomUUID(), "not-a-uuid"]) {
        const token = randomUUID();
        expect(await changeDbCart(storeA, token, { kind: "add", variantId, quantity: 1 })).toEqual({
          ok: false,
          reason: "unavailable",
        });
        expect((await getDbCart(storeA, token)).lines).toEqual([]);
        const carts = await db.execute(sql`SELECT count(*)::int AS n FROM carts WHERE customer_id = ${token}`);
        expect((carts.rows[0] as { n: number }).n).toBe(0);
      }
    });

    it("refuses quantities outside the rule, storing nothing", async () => {
      const token = randomUUID();
      for (const quantity of [-1, 0, 1.5, 1e9, MAX_LINE_QUANTITY + 1]) {
        expect(await changeDbCart(storeA, token, { kind: "add", variantId: published, quantity })).toEqual({
          ok: false,
          reason: "invalid_quantity",
        });
      }
      expect((await getDbCart(storeA, token)).lines).toEqual([]);
    });

    it(`refuses an add that would take a line above ${MAX_LINE_QUANTITY}, keeping the line as it was`, async () => {
      const token = randomUUID();
      await changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: MAX_LINE_QUANTITY });
      expect(await changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: 1 })).toEqual({
        ok: false,
        reason: "quantity_limit",
      });
      expect((await getDbCart(storeA, token)).lines).toEqual([{ variantId: published, quantity: MAX_LINE_QUANTITY }]);
    });

    it("set changes a quantity, 0 removes the line, and a draft Variant is refused", async () => {
      const token = randomUUID();
      await changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: 1 });
      await changeDbCart(storeA, token, { kind: "add", variantId: published2, quantity: 1 });
      expect(await changeDbCart(storeA, token, { kind: "set", variantId: published, quantity: 7 })).toMatchObject({ ok: true });
      expect(await changeDbCart(storeA, token, { kind: "set", variantId: published, quantity: 1e9 })).toEqual({
        ok: false,
        reason: "invalid_quantity",
      });
      expect(await changeDbCart(storeA, token, { kind: "set", variantId: draft, quantity: 3 })).toEqual({
        ok: false,
        reason: "unavailable",
      });
      expect((await getDbCart(storeA, token)).lines).toEqual([
        { variantId: published, quantity: 7 },
        { variantId: published2, quantity: 1 },
      ]);
      expect(await changeDbCart(storeA, token, { kind: "set", variantId: published, quantity: 0 })).toMatchObject({ ok: true });
      expect((await getDbCart(storeA, token)).lines).toEqual([{ variantId: published2, quantity: 1 }]);
    });

    it("remove works for a line whose Product is no longer published", async () => {
      const token = randomUUID();
      await saveDbCartLines(storeA, token, [
        { variantId: draft, quantity: 1 },
        { variantId: published, quantity: 1 },
      ]);
      expect(await changeDbCart(storeA, token, { kind: "remove", variantId: draft })).toMatchObject({ ok: true });
      expect((await getDbCart(storeA, token)).lines).toEqual([{ variantId: published, quantity: 1 }]);
    });

    it("concurrent adds to one Cart are serialized: none is lost", async () => {
      const token = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 30 }, () => changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: 1 })),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect((await getDbCart(storeA, token)).lines).toEqual([{ variantId: published, quantity: 30 }]);
    }, 20000);

    it("40 concurrent adds to 40 new Carts all complete (one pool connection each)", async () => {
      const tokens = Array.from({ length: 40 }, () => randomUUID());
      const results = await Promise.all(
        tokens.map((token) => changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: 1 })),
      );
      expect(results.every((r) => r.ok)).toBe(true);
    }, 20000);
  });

  describe("checkout", () => {
    it("creates an Order from valid lines, priced from the live catalog", async () => {
      const token = randomUUID();
      await changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: 2 });
      await changeDbCart(storeA, token, { kind: "add", variantId: published2, quantity: 3 });
      const { orderId, totalCents } = await checkout(storeA, token);
      expect(totalCents).toBe(2750);
      const lines = await db.execute(
        sql`SELECT variant_id, quantity, unit_price_cents::int AS unit FROM order_lines WHERE order_id = ${orderId} ORDER BY unit`,
      );
      expect(lines.rows).toEqual([
        { variant_id: published2, quantity: 3, unit: 250 },
        { variant_id: published, quantity: 2, unit: 1000 },
      ]);
      expect((await getDbCart(storeA, token)).lines).toEqual([]);
    });

    it("refuses the WHOLE checkout when a line's Product was unpublished after it was added", async () => {
      const token = randomUUID();
      await changeDbCart(storeA, token, { kind: "add", variantId: laterDraft, quantity: 2 });
      await changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: 1 });
      await db.execute(sql`UPDATE products SET status = 'draft' WHERE id = ${laterDraftProduct}`);
      try {
        const error = await checkoutError(storeA, token);
        expect(error.reason).toBe("invalid_lines");
        expect(error.problems).toEqual([{ variantId: laterDraft, reason: "unavailable" }]);
        expect(await orderCount(storeA, token)).toBe(0);
        // Nothing is dropped: the Cart is exactly as it was.
        expect((await getDbCart(storeA, token)).lines).toEqual([
          { variantId: laterDraft, quantity: 2 },
          { variantId: published, quantity: 1 },
        ]);
      } finally {
        await db.execute(sql`UPDATE products SET status = 'published' WHERE id = ${laterDraftProduct}`);
      }
    });

    it("refuses a draft Variant written straight into the Cart", async () => {
      const token = randomUUID();
      await saveDbCartLines(storeA, token, [{ variantId: draft, quantity: 1 }]);
      const error = await checkoutError(storeA, token);
      expect(error.reason).toBe("invalid_lines");
      expect(error.problems).toEqual([{ variantId: draft, reason: "unavailable" }]);
      expect(await orderCount(storeA, token)).toBe(0);
    });

    it("refuses another Store's Variant", async () => {
      const token = randomUUID();
      await saveDbCartLines(storeA, token, [{ variantId: foreign, quantity: 1 }]);
      const error = await checkoutError(storeA, token);
      expect(error.problems).toEqual([{ variantId: foreign, reason: "unavailable" }]);
      expect(await orderCount(storeA, token)).toBe(0);
    });

    it.each([[0], [-1], [100], [1_000_000_000]])(
      "refuses a stored line quantity of %d",
      async (quantity) => {
        const token = randomUUID();
        await saveDbCartLines(storeA, token, [{ variantId: published, quantity }]);
        const error = await checkoutError(storeA, token);
        expect(error.reason).toBe("invalid_lines");
        expect(error.problems).toEqual([{ variantId: published, reason: "invalid_quantity" }]);
        expect(await orderCount(storeA, token)).toBe(0);
      },
    );

    it("refuses an empty or missing Cart", async () => {
      expect((await checkoutError(storeA, randomUUID())).reason).toBe("empty_cart");
      const token = randomUUID();
      await saveDbCartLines(storeA, token, []);
      expect((await checkoutError(storeA, token)).reason).toBe("empty_cart");
    });

    it("two concurrent checkouts of one Cart create exactly one Order", async () => {
      const token = randomUUID();
      await changeDbCart(storeA, token, { kind: "add", variantId: published, quantity: 1 });
      const settled = await Promise.allSettled([checkout(storeA, token), checkout(storeA, token)]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(CheckoutError);
      expect((rejected.reason as CheckoutError).reason).toBe("empty_cart");
      expect(await orderCount(storeA, token)).toBe(1);
    });
  });
});

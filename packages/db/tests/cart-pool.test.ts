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
  saveDbCartLines,
  getDbCart,
  tenantClient,
  platformClient,
} from "../src/index";

/**
 * One pool connection per cart write.
 *
 * The tenant pool is shared by every Store and keeps pg's default size (10
 * connections). A database function that holds one connection while it asks
 * the pool for another deadlocks it once ten such calls overlap: each holds a
 * connection and waits forever for an eleventh. saveDbCartLines used to do
 * exactly that (it called getOrCreateDbCart, which opened a second
 * tenantClient), so a burst of anonymous add-to-cart requests hung every
 * Store's storefront.
 */

/** Rejects if `promise` has not settled within `ms` (a wedged pool never settles). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not finish within ${ms} ms: the tenant pool is deadlocked`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const CONCURRENT = 40;
const DEADLINE_MS = 8000;

describe("Cart writes use one pool connection each", () => {
  let pool: Pool;
  let storeId: string;
  let variantId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE order_lines, orders, cart_items, carts, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );
    const owner = randomUUID();
    await db.execute(sql`INSERT INTO "user" (id, name, email) VALUES (${owner}, 'Pool', 'pool@example.com')`);
    const s = await provisionStore({ name: "PoolStore", subdomain: "pool-store", ownerId: owner });
    storeId = s.store.id;
    const product = await createProduct(storeId, {
      title: "Widget",
      slug: "widget",
      status: "published",
      variants: [{ sku: "W-1", title: "Default", priceCents: 1000, inventory: 100 }],
    });
    variantId = product.variants[0]!.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  it("a tenantClient cannot be opened inside another client's callback (it would hold two connections)", async () => {
    await expect(
      within(
        tenantClient(storeId, async () => tenantClient(storeId, async () => "nested")),
        DEADLINE_MS,
        "a nested tenantClient",
      ),
    ).rejects.toThrow(/inside another database client/);
    await expect(
      within(
        platformClient(async () => tenantClient(storeId, async () => "nested")),
        DEADLINE_MS,
        "a tenantClient inside a platformClient",
      ),
    ).rejects.toThrow(/inside another database client/);
    await expect(
      within(
        tenantClient(storeId, async () => platformClient(async () => "nested")),
        DEADLINE_MS,
        "a platformClient inside a tenantClient",
      ),
    ).rejects.toThrow(/inside another database client/);
  }, 30000);

  it("sequential and sibling clients still work (only nesting is refused)", async () => {
    const [a, b] = await Promise.all([
      tenantClient(storeId, async () => "a"),
      platformClient(async () => "b"),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
    expect(await tenantClient(storeId, async () => "after")).toBe("after");
  });

  it(`${CONCURRENT} concurrent saveDbCartLines calls (${CONCURRENT} new Carts) all complete`, async () => {
    const tokens = Array.from({ length: CONCURRENT }, () => randomUUID());
    await within(
      Promise.all(tokens.map((token) => saveDbCartLines(storeId, token, [{ variantId, quantity: 1 }]))),
      DEADLINE_MS,
      `${CONCURRENT} concurrent saveDbCartLines calls`,
    );
    const carts = await Promise.all(tokens.map((token) => getDbCart(storeId, token)));
    expect(carts.map((c) => c.lines)).toEqual(tokens.map(() => [{ variantId, quantity: 1 }]));
  }, 20000);
});

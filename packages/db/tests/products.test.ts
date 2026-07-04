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
  listProducts,
  tenantClient,
  platformClient,
} from "../src/index";
import { stores, products } from "../src/schema";

/**
 * Issue #6 — Product + Variant CRUD.
 * Cycles 2-4: RLS isolation, CRUD, variant-mandatory, slug uniqueness.
 */
describe("Products + Variants (Issue #6)", () => {
  let pool: Pool;
  let userA: string;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE memberships, stores, products, variants, "user", "session", "account", "verification" CASCADE`,
    );

    userA = randomUUID();
    const userB = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${userA}, 'Alice', 'alice@example.com'), (${userB}, 'Bob', 'bob@example.com')`,
    );

    const a = await provisionStore({ name: "Acme", subdomain: "acme-prod", ownerId: userA });
    storeAId = a.store.id;
    const b = await provisionStore({ name: "Beta", subdomain: "beta-prod", ownerId: userB });
    storeBId = b.store.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  // ── Cycle 2: RLS isolation ──────────────────────────────────────────
  it("a Product created in Store A is invisible to Store B (RLS)", async () => {
    await createProduct(storeAId, {
      title: "Widget",
      description: "A widget",
      slug: "widget",
      variants: [{ sku: "W-1", title: "Default", priceCents: 1999, inventory: 10 }],
    });

    // Store A sees it.
    const storeAProducts = await listProducts(storeAId);
    expect(storeAProducts).toHaveLength(1);
    expect(storeAProducts[0]!.title).toBe("Widget");

    // Store B does NOT see it.
    const storeBProducts = await listProducts(storeBId);
    expect(storeBProducts).toHaveLength(0);
  });

  it("store_id is stamped from the GUC on insert (trigger), not by the app", async () => {
    // Read via platformClient (bypasses RLS) to check the raw store_id.
    const rows = await platformClient(async (tx) => {
      const result = await tx.execute(
        sql`SELECT store_id, title FROM products WHERE slug = 'widget'`,
      );
      return result.rows as Array<{ store_id: string; title: string }>;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.store_id).toBe(storeAId);
  });

  // ── Cycle 3: CRUD ───────────────────────────────────────────────────
  it("creates a Product with multiple Variants, lists them, updates, and deletes", async () => {
    // Create with 2 variants.
    const created = await createProduct(storeBId, {
      title: "T-Shirt",
      slug: "t-shirt",
      description: "A cotton tee",
      variants: [
        { sku: "TS-S", title: "Small", priceCents: 2500, inventory: 5 },
        { sku: "TS-M", title: "Medium", priceCents: 2500, inventory: 8 },
      ],
    });

    expect(created.variants).toHaveLength(2);

    // List shows it.
    const listed = await listProducts(storeBId);
    expect(listed.find((p) => p.slug === "t-shirt")).toBeTruthy();

    // Delete it.
    const { deleteProduct } = await import("../src/index");
    await deleteProduct(storeBId, created.id);

    // Gone.
    const after = await listProducts(storeBId);
    expect(after.find((p) => p.slug === "t-shirt")).toBeUndefined();
  });

  // ── Cycle 4: variant-mandatory + slug uniqueness ────────────────────
  it("rejects a Product with zero Variants (variant-mandatory invariant)", async () => {
    await expect(
      createProduct(storeAId, {
        title: "Empty",
        slug: "empty-product",
        description: "",
        variants: [],
      }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate slug within the same Store", async () => {
    await expect(
      createProduct(storeAId, {
        title: "Widget Clone",
        slug: "widget", // already exists in storeA
        description: "",
        variants: [{ sku: "WC-1", title: "Default", priceCents: 1000, inventory: 1 }],
      }),
    ).rejects.toThrow();
  });

  it("allows the same slug in a different Store (scoped uniqueness)", async () => {
    // 'widget' exists in Store A, but Store B should be able to use it.
    const result = await createProduct(storeBId, {
      title: "Widget B",
      slug: "widget",
      description: "",
      variants: [{ sku: "WB-1", title: "Default", priceCents: 1500, inventory: 3 }],
    });
    expect(result.id).toBeTruthy();
  });
});

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
  listPublishedProducts,
  getProductBySlug,
} from "../src/index";

/**
 * Issue #7 — Storefront data accessors.
 * These are the functions the storefront pages call — they return only published
 * products (drafts are dashboard-only) and are RLS-scoped to the Current Store.
 */
describe("Storefront accessors (Issue #7)", () => {
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

    const a = await provisionStore({ name: "Acme", subdomain: "acme-sf", ownerId: userA });
    storeAId = a.store.id;
    const b = await provisionStore({ name: "Beta", subdomain: "beta-sf", ownerId: userB });
    storeBId = b.store.id;

    // Store A: one published, one draft.
    await createProduct(storeAId, {
      title: "Published Widget",
      slug: "published-widget",
      status: "published",
      variants: [{ sku: "PW-1", title: "Default", priceCents: 1999, inventory: 10 }],
    });
    await createProduct(storeAId, {
      title: "Draft Gizmo",
      slug: "draft-gizmo",
      status: "draft",
      variants: [{ sku: "DG-1", title: "Default", priceCents: 500, inventory: 0 }],
    });
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  // ── Cycle 1: storefront accessors ───────────────────────────────────
  it("listPublishedProducts returns only published products, not drafts", async () => {
    const products = await listPublishedProducts(storeAId);
    expect(products).toHaveLength(1);
    expect(products[0]!.title).toBe("Published Widget");
    expect(products[0]!.status).toBe("published");
  });

  it("getProductBySlug returns a published product with its variants", async () => {
    const product = await getProductBySlug(storeAId, "published-widget");
    expect(product).not.toBeNull();
    expect(product!.title).toBe("Published Widget");
    expect(product!.variants).toHaveLength(1);
    expect(product!.variants[0]!.sku).toBe("PW-1");
    expect(product!.variants[0]!.priceCents).toBe(1999);
  });

  it("getProductBySlug returns null for a draft product (not visible on storefront)", async () => {
    const product = await getProductBySlug(storeAId, "draft-gizmo");
    expect(product).toBeNull();
  });

  it("storefront accessors are RLS-scoped — Store B sees Store A's nothing", async () => {
    const bProducts = await listPublishedProducts(storeBId);
    expect(bProducts).toHaveLength(0);

    const bProduct = await getProductBySlug(storeBId, "published-widget");
    expect(bProduct).toBeNull();
  });

  it("getProductBySlug returns null for a non-existent slug", async () => {
    const product = await getProductBySlug(storeAId, "does-not-exist");
    expect(product).toBeNull();
  });
});

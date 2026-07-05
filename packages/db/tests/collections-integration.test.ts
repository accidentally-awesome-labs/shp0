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
  createCollection,
  listCollections,
  addCollectionMembers,
  listCollectionMembers,
  removeCollectionMember,
} from "../src/index";
import type { CollectionRule } from "../src/collections";

/**
 * Issue #11 — Collections: Manual + Automated.
 */
describe("Collections — manual + automated (Issue #11)", () => {
  let pool: Pool;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE collection_products, collections, cart_items, carts, order_lines, orders, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );

    const userA = randomUUID();
    const userB = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${userA}, 'A', 'a@example.com'), (${userB}, 'B', 'b@example.com')`,
    );

    const a = await provisionStore({ name: "Alpha", subdomain: "alpha-coll", ownerId: userA });
    storeAId = a.store.id;
    const b = await provisionStore({ name: "Beta", subdomain: "beta-coll", ownerId: userB });
    storeBId = b.store.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  // ── Manual collection CRUD ──────────────────────────────────────────
  it("creates a manual collection and lists it", async () => {
    const col = await createCollection(storeAId, {
      name: "Featured",
      slug: "featured",
      type: "manual",
    });
    expect(col.id).toBeDefined();
    expect(col.type).toBe("manual");

    const cols = await listCollections(storeAId);
    expect(cols).toHaveLength(1);
    expect(cols[0]!.name).toBe("Featured");
  });

  it("a manual collection starts with no members", async () => {
    const cols = await listCollections(storeAId);
    const members = await listCollectionMembers(storeAId, cols[0]!.id);
    expect(members).toHaveLength(0);
  });

  it("adds products to a manual collection and lists members", async () => {
    await createProduct(storeAId, {
      title: "Widget", description: "", slug: "widget", tags: ["gadget"],
      variants: [{ sku: "W-1", title: "Default", priceCents: 1500, inventory: 10 }],
    });
    await createProduct(storeAId, {
      title: "Gizmo", description: "", slug: "gizmo", tags: ["gadget"],
      variants: [{ sku: "G-1", title: "Default", priceCents: 3000, inventory: 5 }],
    });
    const storeProducts = await listProducts(storeAId);
    expect(storeProducts).toHaveLength(2);

    const cols = await listCollections(storeAId);
    await addCollectionMembers(storeAId, cols[0]!.id, storeProducts.map((p) => p.id));

    const members = await listCollectionMembers(storeAId, cols[0]!.id);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.title).sort()).toEqual(["Gizmo", "Widget"]);
  });

  it("removes a product from a manual collection", async () => {
    const cols = await listCollections(storeAId);
    const storeProducts = await listProducts(storeAId);
    const widgetId = storeProducts.find((p) => p.title === "Widget")!.id;

    await removeCollectionMember(storeAId, cols[0]!.id, widgetId);

    const members = await listCollectionMembers(storeAId, cols[0]!.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.title).toBe("Gizmo");
  });

  // ── RLS isolation ──────────────────────────────────────────────────
  it("a collection in Store A is invisible to Store B (RLS)", async () => {
    const storeBCols = await listCollections(storeBId);
    expect(storeBCols).toHaveLength(0);
  });

  // ── Automated collection: tag rule ─────────────────────────────────
  it("an automated collection with a tag rule matches products with that tag", async () => {
    await createProduct(storeAId, {
      title: "Summer Hat", description: "", slug: "summer-hat", tags: ["summer", "accessory"],
      variants: [{ sku: "SH-1", title: "Default", priceCents: 2500, inventory: 8 }],
    });
    await createProduct(storeAId, {
      title: "Winter Coat", description: "", slug: "winter-coat", tags: ["winter"],
      variants: [{ sku: "WC-1", title: "Default", priceCents: 9000, inventory: 3 }],
    });

    const tagRule: CollectionRule = { type: "tag", tag: "summer" };
    await createCollection(storeAId, {
      name: "Summer Items", slug: "summer-items", type: "automated", rule: tagRule,
    });

    const cols = await listCollections(storeAId);
    const summerCol = cols.find((c) => c.slug === "summer-items")!;
    const members = await listCollectionMembers(storeAId, summerCol.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.title).toBe("Summer Hat");
  });

  // ── Automated collection: price_range rule ─────────────────────────
  it("an automated collection with a price range rule matches products in range", async () => {
    const priceRule: CollectionRule = { type: "price_range", minCents: 1000, maxCents: 4000 };
    await createCollection(storeAId, {
      name: "Budget", slug: "budget", type: "automated", rule: priceRule,
    });

    const cols = await listCollections(storeAId);
    const budgetCol = cols.find((c) => c.slug === "budget")!;
    const members = await listCollectionMembers(storeAId, budgetCol.id);
    const titles = members.map((m) => m.title).sort();
    // In range: Widget (1500), Gizmo (3000), Summer Hat (2500). Out: Winter Coat (9000).
    expect(titles).toContain("Widget");
    expect(titles).toContain("Gizmo");
    expect(titles).toContain("Summer Hat");
    expect(titles).not.toContain("Winter Coat");
  });

  // ── Automated collection: updates as catalog changes ───────────────
  it("automated membership updates as the catalog changes (no stale data)", async () => {
    const tagRule: CollectionRule = { type: "tag", tag: "new-arrivals" };
    await createCollection(storeAId, {
      name: "New Arrivals", slug: "new-arrivals", type: "automated", rule: tagRule,
    });

    const cols = await listCollections(storeAId);
    const col = cols.find((c) => c.slug === "new-arrivals")!;

    let members = await listCollectionMembers(storeAId, col.id);
    expect(members).toHaveLength(0);

    await createProduct(storeAId, {
      title: "Fresh Item", description: "", slug: "fresh-item", tags: ["new-arrivals"],
      variants: [{ sku: "FI-1", title: "Default", priceCents: 1200, inventory: 20 }],
    });

    members = await listCollectionMembers(storeAId, col.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.title).toBe("Fresh Item");
  });
});


import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq, sql, and } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export * as schema from "./schema";
export { parseMoney, formatMoney, applyPercent } from "./money";
export { addLine, updateLine, removeLine, computeSubtotal, mergeCarts } from "./cart";
export type { Cart, CartLine } from "./cart";
export { transitionPayment, transitionFulfillment, isOrderOpen } from "./order";
export type { PaymentStatus, FulfillmentStatus } from "./order";
export { computeApplicationFee, buildCheckoutSessionParams } from "./payments";
export type { CheckoutSessionParams } from "./payments";
export { matchesRule } from "./collections";
export type { CollectionRule, ProductForRule } from "./collections";
export type { Store, NewStore, Membership, NewMembership, Product, NewProduct, Variant, NewVariant, CartRow, NewCart, CartItem, NewCartItem, Order, NewOrder, OrderLine, NewOrderLine, Collection, NewCollection } from "./schema";
import type { Cart, CartLine } from "./cart";

/**
 * Two roles, two connection pools (per ADR-0001):
 * - tenant:  logged in as the `default` role — subject to RLS, fail-closed.
 * - platform: logged in as the `cloud_admin` role — bypasses RLS, cross-Store only.
 *
 * In production these point at role-specific Neon connection strings; locally they
 * connect to the shp0_test database over the trust-authenticated socket.
 */
const TENANT_DATABASE_URL =
  process.env.TENANT_DATABASE_URL ?? "postgresql:///shp0_test?user=default";
const PLATFORM_DATABASE_URL =
  process.env.PLATFORM_DATABASE_URL ??
  "postgresql:///shp0_test?user=cloud_admin";

let tenantPool: Pool | null = null;
let platformPool: Pool | null = null;

function getTenantPool(): Pool {
  if (!tenantPool) tenantPool = new Pool({ connectionString: TENANT_DATABASE_URL });
  return tenantPool;
}
function getPlatformPool(): Pool {
  if (!platformPool)
    platformPool = new Pool({ connectionString: PLATFORM_DATABASE_URL });
  return platformPool;
}

/** A Drizzle client bound to a single connection running inside our transaction. */
type Tx = NodePgDatabase<typeof schema>;

/**
 * Run `fn` against the current Store's data, scoped by the database itself.
 *
 * `app.store_id` is set with `SET LOCAL` inside a transaction, so the GUC is
 * structurally inseparable from the query and resets at COMMIT. RLS policies
 * enforce `current_setting('app.store_id', true) = store_id`; with the GUC unset
 * the policy matches zero rows (fail-closed). This is the only tenant query path.
 */
export async function tenantClient<T>(
  storeId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await getTenantPool().connect();
  try {
    await client.query("BEGIN");
    // set_config(..., true) sets a transaction-local GUC (== SET LOCAL) and,
    // unlike SET, accepts a bind parameter — so the store id is never string-built.
    await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    const tx = drizzle(client, { schema });
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` with cross-Store access, bypassing RLS (the `cloud_admin` role).
 * Reserved for platform operations — operator admin, analytics, Store creation.
 * Never used to serve a single Store.
 */
export async function platformClient<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await getPlatformPool().connect();
  try {
    const tx = drizzle(client, { schema });
    return await fn(tx);
  } finally {
    client.release();
  }
}

/**
 * Apply the schema + RLS roles/policies. Idempotent. Run as `cloud_admin`.
 *
 * For the tenant bootstrap `stores` table, a trigger stamps `store_id := id` on
 * insert (the platform creates Stores, so the per-request GUC is not set then).
 */
export async function applySchema(): Promise<void> {
  const pool = new Pool({ connectionString: PLATFORM_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        name text NOT NULL,
        subdomain text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // Add subdomain column to existing databases (idempotent migration).
    // Can't reference `id` in DEFAULT, so add nullable, backfill, then set NOT NULL.
    await client.query(`
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS subdomain text;
      UPDATE stores SET subdomain = 'pending-' || id::text WHERE subdomain IS NULL;
      ALTER TABLE stores ALTER COLUMN subdomain SET NOT NULL;
      ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_subdomain_key;
      ALTER TABLE stores ADD CONSTRAINT stores_subdomain_key UNIQUE (subdomain);
    `);

    // Row-Level Security, keyed on the per-request GUC (ADR-0001).
    await client.query(`ALTER TABLE stores ENABLE ROW LEVEL SECURITY;`);

    await client.query(`
      DROP POLICY IF EXISTS stores_tenant_select ON stores;
      CREATE POLICY stores_tenant_select ON stores
        FOR SELECT TO "default"
        USING (current_setting('app.store_id', true) = store_id::text);
    `);

    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON stores TO "default";`);

    // ── memberships (PLATFORM table — bridges global users to Stores) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        role text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // Single-Owner invariant part 1: at most one owner per Store.
    await client.query(`
      DROP INDEX IF EXISTS memberships_one_owner_per_store;
      CREATE UNIQUE INDEX memberships_one_owner_per_store
        ON memberships(store_id) WHERE role = 'owner';
    `);
    // Single-Owner invariant part 2: the owner cannot be removed (deleted).
    // Transfer = UPDATE the row's user_id, not delete.
    await client.query(`
      CREATE OR REPLACE FUNCTION memberships_prevent_owner_delete()
      RETURNS trigger LANGUAGE plpgsql AS $func$
      BEGIN
        IF OLD.role = 'owner' THEN
          RAISE EXCEPTION 'Cannot delete an owner Membership. Transfer ownership first.';
        END IF;
        RETURN OLD;
      END;
      $func$;
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS memberships_no_delete_owner ON memberships;
      CREATE TRIGGER memberships_no_delete_owner
        BEFORE DELETE ON memberships
        FOR EACH ROW EXECUTE FUNCTION memberships_prevent_owner_delete();
    `);

    // ── better-auth core tables (PLATFORM tables — no store_id, no RLS) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS "user" (
        id text PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL UNIQUE,
        email_verified boolean NOT NULL DEFAULT false,
        image text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        id text PRIMARY KEY,
        expires_at timestamptz NOT NULL,
        token text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        ip_address text,
        user_agent text,
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "account" (
        id text PRIMARY KEY,
        account_id text NOT NULL,
        provider_id text NOT NULL,
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        access_token text,
        refresh_token text,
        id_token text,
        access_token_expires_at timestamptz,
        refresh_token_expires_at timestamptz,
        scope text,
        password text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "verification" (
        id text PRIMARY KEY,
        identifier text NOT NULL,
        value text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz,
        updated_at timestamptz
      );
    `);
    // Auth tables are platform tables — cloud_admin owns them, no RLS, no grant to "default".

    // ── products + variants (TENANT tables — store_id GUC, RLS-protected) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        title text NOT NULL,
        slug text NOT NULL,
        description text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'draft',
        tags text[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS variants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        sku text NOT NULL,
        title text NOT NULL,
        price_cents bigint NOT NULL,
        compare_at_price_cents bigint,
        inventory integer NOT NULL DEFAULT 0,
        position integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // Generic trigger: stamp store_id from the per-request GUC on INSERT.
    // The app never passes store_id — the DB always sets it (ADR-0001).
    await client.query(`
      CREATE OR REPLACE FUNCTION stamp_store_id()
      RETURNS trigger LANGUAGE plpgsql AS $func$
      BEGIN
        NEW.store_id := current_setting('app.store_id', true)::uuid;
        RETURN NEW;
      END;
      $func$;
    `);
    await client.query(`DROP TRIGGER IF EXISTS products_set_store_id ON products; CREATE TRIGGER products_set_store_id BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`DROP TRIGGER IF EXISTS variants_set_store_id ON variants; CREATE TRIGGER variants_set_store_id BEFORE INSERT ON variants FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);

    // RLS: products + variants are tenant-isolated (same pattern as stores).
    await client.query(`ALTER TABLE products ENABLE ROW LEVEL SECURITY;`);
    await client.query(`ALTER TABLE variants ENABLE ROW LEVEL SECURITY;`);
    await client.query(`
      DROP POLICY IF EXISTS products_tenant ON products;
      CREATE POLICY products_tenant ON products
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    await client.query(`
      DROP POLICY IF EXISTS variants_tenant ON variants;
      CREATE POLICY variants_tenant ON variants
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    // Scoped-unique slug per Store.
    await client.query(`DROP INDEX IF EXISTS products_store_slug_unique; CREATE UNIQUE INDEX products_store_slug_unique ON products(store_id, slug);`);
    // Grant to tenant role.
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON products, variants TO "default";`);

    // ── carts + cart_items (TENANT tables — ephemeral, RLS-protected) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS carts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        customer_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS cart_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
        variant_id uuid NOT NULL,
        quantity integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // store_id stamped from GUC by the existing stamp_store_id() trigger.
    await client.query(`DROP TRIGGER IF EXISTS carts_set_store_id ON carts; CREATE TRIGGER carts_set_store_id BEFORE INSERT ON carts FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`DROP TRIGGER IF EXISTS cart_items_set_store_id ON cart_items; CREATE TRIGGER cart_items_set_store_id BEFORE INSERT ON cart_items FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    // RLS: carts + cart_items are tenant-isolated.
    await client.query(`ALTER TABLE carts ENABLE ROW LEVEL SECURITY;`);
    await client.query(`ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;`);
    await client.query(`
      DROP POLICY IF EXISTS carts_tenant ON carts;
      CREATE POLICY carts_tenant ON carts
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    await client.query(`
      DROP POLICY IF EXISTS cart_items_tenant ON cart_items;
      CREATE POLICY cart_items_tenant ON cart_items
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    // One cart per customer per store.
    await client.query(`DROP INDEX IF EXISTS carts_store_customer_unique; CREATE UNIQUE INDEX carts_store_customer_unique ON carts(store_id, customer_id);`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON carts, cart_items TO "default";`);

    // ── orders + order_lines (TENANT tables — RLS-protected) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        customer_id text NOT NULL,
        payment_status text NOT NULL DEFAULT 'pending',
        fulfillment_status text NOT NULL DEFAULT 'unfulfilled',
        total_cents bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        variant_id uuid NOT NULL,
        quantity integer NOT NULL,
        unit_price_cents bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // store_id stamped from GUC by the existing stamp_store_id() trigger.
    await client.query(`DROP TRIGGER IF EXISTS orders_set_store_id ON orders; CREATE TRIGGER orders_set_store_id BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`DROP TRIGGER IF EXISTS order_lines_set_store_id ON order_lines; CREATE TRIGGER order_lines_set_store_id BEFORE INSERT ON order_lines FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    // RLS: orders + order_lines are tenant-isolated.
    await client.query(`ALTER TABLE orders ENABLE ROW LEVEL SECURITY;`);
    await client.query(`ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;`);
    await client.query(`
      DROP POLICY IF EXISTS orders_tenant ON orders;
      CREATE POLICY orders_tenant ON orders
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    await client.query(`
      DROP POLICY IF EXISTS order_lines_tenant ON order_lines;
      CREATE POLICY order_lines_tenant ON order_lines
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON orders, order_lines TO "default";`);

    // ── collections + collection_products (tenant tables, RLS-protected) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS collections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        name text NOT NULL,
        slug text NOT NULL,
        type text NOT NULL,
        rule jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS collection_products (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        position integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`DROP TRIGGER IF EXISTS collections_set_store_id ON collections; CREATE TRIGGER collections_set_store_id BEFORE INSERT ON collections FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`DROP TRIGGER IF EXISTS collection_products_set_store_id ON collection_products; CREATE TRIGGER collection_products_set_store_id BEFORE INSERT ON collection_products FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`ALTER TABLE collections ENABLE ROW LEVEL SECURITY;`);
    await client.query(`ALTER TABLE collection_products ENABLE ROW LEVEL SECURITY;`);
    await client.query(`
      DROP POLICY IF EXISTS collections_tenant ON collections;
      CREATE POLICY collections_tenant ON collections
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    await client.query(`
      DROP POLICY IF EXISTS collection_products_tenant ON collection_products;
      CREATE POLICY collection_products_tenant ON collection_products
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON collections, collection_products TO "default";`);

    // ── commission_bps on stores (idempotent migration) ──
    await client.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS commission_bps integer NOT NULL DEFAULT 250;`);

    // ── stripe_payment_accounts (PLATFORM table — no RLS) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS stripe_payment_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
        connect_account_id text NOT NULL,
        details_submitted boolean NOT NULL DEFAULT false,
        charges_enabled boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // ── processed_events (PLATFORM table — idempotency, no RLS) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS processed_events (
        id text PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  } finally {
    client.release();
    await pool.end();
  }
}

/** Close pools (for tests / clean shutdown). */
export async function closePools(): Promise<void> {
  if (tenantPool) await tenantPool.end();
  if (platformPool) await platformPool.end();
  tenantPool = null;
  platformPool = null;
}

// ─────────────────────────────────────────────────────────────────────────
// Store provisioning + Membership domain functions (Issue #4).
// All run via platformClient — Store creation and Membership are platform ops.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Provision a new Store and make the given user its Owner, atomically.
 *
 * Store creation is a platform operation: the platform mints the Store's id,
 * sets store_id = id, and creates the creator's Membership with role = 'owner'.
 * Both inserts run in a single transaction via platformClient — if either
 * fails, neither happens.
 */
export async function provisionStore(opts: {
  name: string;
  subdomain: string;
  ownerId: string;
}): Promise<{ store: typeof schema.stores.$inferSelect }> {
  return platformClient(async (tx) => {
    const id = randomUUID();
    const [store] = await tx
      .insert(schema.stores)
      .values({
        id,
        storeId: id,
        name: opts.name,
        subdomain: opts.subdomain,
      })
      .returning();

    await tx.insert(schema.memberships).values({
      userId: opts.ownerId,
      storeId: id,
      role: "owner",
    });

    return { store: store! };
  });
}

/**
 * List all Stores a Merchant (user) belongs to via Memberships.
 * Returns each Store with the Merchant's Role in it — the data behind the
 * store switcher.
 */
export async function listMemberships(
  userId: string,
): Promise<
  Array<{
    storeId: string;
    storeName: string;
    subdomain: string;
    role: string;
  }>
> {
  return platformClient(async (tx) => {
    const rows = await tx
      .select({
        storeId: schema.memberships.storeId,
        storeName: schema.stores.name,
        subdomain: schema.stores.subdomain,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(
        schema.stores,
        eq(schema.memberships.storeId, schema.stores.id),
      )
      .where(eq(schema.memberships.userId, userId));

    return rows;
  });
}

/**
 * Check whether a subdomain is available (not taken by another Store).
 * Used for real-time validation during Store creation.
 */
export async function checkSubdomainAvailable(
  subdomain: string,
): Promise<boolean> {
  return platformClient(async (tx) => {
    const rows = await tx
      .select({ id: schema.stores.id })
      .from(schema.stores)
      .where(eq(schema.stores.subdomain, subdomain))
      .limit(1);
    return rows.length === 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Current Store resolution (Issue #5).
// The authorization layer ABOVE RLS: RLS isolates between Stores given a
// storeId; these functions decide which storeId a request may even be in.
// ─────────────────────────────────────────────────────────────────────────

/** Subdomains reserved for the platform itself, never a Store. */
const RESERVED_SUBDOMAINS = new Set(["app", "www", "dashboard", "api", "mail"]);

/**
 * Parse a request host and extract the Store subdomain, if any.
 *
 * Pure function — no DB call. Returns the subdomain string for a Store host
 * like "acme.shp0.dev", or null for the platform domain, localhost/dev, and
 * reserved subdomains (app, www, dashboard, api, mail).
 */
export function parseSubdomain(
  host: string,
  platformDomain: string = "shp0.dev",
): string | null {
  // Strip port if present (e.g. "localhost:3000").
  const hostname = host.split(":")[0]!;

  // Must end with the platform domain.
  if (!hostname.endsWith(`.${platformDomain}`)) return null;

  const subdomain = hostname.slice(0, hostname.length - platformDomain.length - 1);

  // No subdomain = the platform domain itself.
  if (!subdomain) return null;

  // Reserved subdomains are platform, not a Store.
  if (RESERVED_SUBDOMAINS.has(subdomain)) return null;

  return subdomain;
}

/**
 * Check whether a Merchant (user) holds an active Membership for the given Store.
 * This is the dashboard authorization gate: a Merchant's Store selection is
 * only honored if they actually belong to that Store.
 */
export async function authorizeStoreMembership(
  userId: string,
  storeId: string,
): Promise<boolean> {
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT 1 FROM memberships WHERE user_id = ${userId} AND store_id = ${storeId} LIMIT 1`,
    );
    return rows.rows.length > 0;
  });
}

/**
 * Resolve a Store by its subdomain. Returns the storeId if the subdomain
 * exists, or null if it doesn't. Used for storefront host-based resolution.
 */
export async function resolveStoreBySubdomain(
  subdomain: string,
): Promise<string | null> {
  return platformClient(async (tx) => {
    const rows = await tx
      .select({ id: schema.stores.id })
      .from(schema.stores)
      .where(eq(schema.stores.subdomain, subdomain))
      .limit(1);
    return rows.length > 0 ? rows[0]!.id : null;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Product + Variant CRUD (Issue #6).
// All run via tenantClient(storeId) — scoped by RLS, store_id stamped by trigger.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Create a Product with its Variants. Every Product must have at least one
 * Variant (the single purchasable unit). Both inserts run inside a single
 * tenantClient transaction — store_id is stamped from the GUC by the trigger.
 */
export async function createProduct(
  storeId: string,
  input: {
    title: string;
    slug: string;
    description?: string;
    status?: string;
    tags?: string[];
    variants: Array<{
      sku: string;
      title: string;
      priceCents: number;
      compareAtPriceCents?: number;
      inventory?: number;
      position?: number;
    }>;
  },
): Promise<{ id: string; variants: Array<{ id: string }> }> {
  if (input.variants.length === 0) {
    throw new Error("A Product must have at least one Variant");
  }

  return tenantClient(storeId, async (tx) => {
    const [product] = await tx
      .insert(schema.products)
      .values({
        storeId,
        title: input.title,
        slug: input.slug,
        description: input.description ?? "",
        status: input.status ?? "draft",
        tags: input.tags ?? [],
      })
      .returning();

    const createdVariants: Array<{ id: string }> = [];
    for (const v of input.variants) {
      const [variant] = await tx
        .insert(schema.variants)
        .values({
          storeId,
          productId: product!.id,
          sku: v.sku,
          title: v.title,
          priceCents: v.priceCents,
          compareAtPriceCents: v.compareAtPriceCents,
          inventory: v.inventory ?? 0,
          position: v.position ?? 0,
        })
        .returning();
      createdVariants.push({ id: variant!.id });
    }

    return { id: product!.id, variants: createdVariants };
  });
}

/**
 * List all Products (with their Variants) for the Current Store.
 * Reads via tenantClient — RLS ensures only this Store's products are visible.
 */
export async function listProducts(
  storeId: string,
): Promise<
  Array<{
    id: string;
    title: string;
    slug: string;
    status: string;
    variants: Array<{
      id: string;
      sku: string;
      title: string;
      priceCents: number;
      inventory: number;
    }>;
  }>
> {
  return tenantClient(storeId, async (tx) => {
    const productList = await tx
      .select({
        id: schema.products.id,
        title: schema.products.title,
        slug: schema.products.slug,
        status: schema.products.status,
      })
      .from(schema.products)
      .orderBy(eq(schema.products.createdAt, schema.products.createdAt));

    const results = [];
    for (const p of productList) {
      const variantList = await tx
        .select({
          id: schema.variants.id,
          sku: schema.variants.sku,
          title: schema.variants.title,
          priceCents: schema.variants.priceCents,
          inventory: schema.variants.inventory,
        })
        .from(schema.variants)
        .where(eq(schema.variants.productId, p.id));

      results.push({ ...p, variants: variantList });
    }
    return results;
  });
}

/**
 * Delete a Product (cascades to its Variants). RLS ensures only the Current
 * Store's products are deletable.
 */
export async function deleteProduct(
  storeId: string,
  productId: string,
): Promise<void> {
  await tenantClient(storeId, async (tx) => {
    await tx
      .delete(schema.products)
      .where(eq(schema.products.id, productId));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Storefront data accessors (Issue #7).
// Like the dashboard CRUD but only return PUBLISHED products. These are the
// functions the storefront pages call — ISR-cached in the web layer.
// ─────────────────────────────────────────────────────────────────────────

/**
 * List published products for the storefront. Drafts are excluded — they are
 * dashboard-only. RLS ensures only the Current Store's products are visible.
 */
export async function listPublishedProducts(
  storeId: string,
): Promise<
  Array<{
    id: string;
    title: string;
    slug: string;
    status: string;
    minPriceCents: number;
  }>
> {
  return tenantClient(storeId, async (tx) => {
    const productList = await tx
      .select({
        id: schema.products.id,
        title: schema.products.title,
        slug: schema.products.slug,
        status: schema.products.status,
      })
      .from(schema.products)
      .where(eq(schema.products.status, "published"));

    const results = [];
    for (const p of productList) {
      const variantList = await tx
        .select({ priceCents: schema.variants.priceCents })
        .from(schema.variants)
        .where(eq(schema.variants.productId, p.id));
      const minPriceCents = variantList.length > 0
        ? Math.min(...variantList.map((v) => v.priceCents))
        : 0;
      results.push({ ...p, minPriceCents });
    }
    return results;
  });
}

/**
 * Get a single published product by slug, with all its variants.
 * Returns null if the product doesn't exist, is a draft, or belongs to another
 * Store (RLS returns zero rows).
 */
export async function getProductBySlug(
  storeId: string,
  slug: string,
): Promise<{
  id: string;
  title: string;
  slug: string;
  description: string;
  variants: Array<{
    id: string;
    sku: string;
    title: string;
    priceCents: number;
    compareAtPriceCents: number | null;
    inventory: number;
  }>;
} | null> {
  return tenantClient(storeId, async (tx) => {
    const productList = await tx
      .select({
        id: schema.products.id,
        title: schema.products.title,
        slug: schema.products.slug,
        description: schema.products.description,
      })
      .from(schema.products)
      .where(
        and(
          eq(schema.products.slug, slug),
          eq(schema.products.status, "published"),
        ),
      )
      .limit(1);

    if (productList.length === 0) return null;

    const p = productList[0]!;
    const variantList = await tx
      .select({
        id: schema.variants.id,
        sku: schema.variants.sku,
        title: schema.variants.title,
        priceCents: schema.variants.priceCents,
        compareAtPriceCents: schema.variants.compareAtPriceCents,
        inventory: schema.variants.inventory,
      })
      .from(schema.variants)
      .where(eq(schema.variants.productId, p.id));

    return { ...p, variants: variantList };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Cache-tag functions (Issue #7).
// These generate the revalidateTag keys for ISR — targeted cache invalidation
// so a product edit only busts that product's pages, not the entire cache.
// ─────────────────────────────────────────────────────────────────────────

/** Cache tag for a single product's pages (detail page). */
export function productTag(storeId: string, productId: string): string {
  return `store:${storeId}:product:${productId}`;
}

/** Cache tag for a Store's product listing page. */
export function storeProductsTag(storeId: string): string {
  return `store:${storeId}:products`;
}

// ─────────────────────────────────────────────────────────────────────────
// DB-backed cart CRUD (Issue #8).
// For authenticated Customers — one cart per customer per store, RLS-scoped.
// All via tenantClient. The pure line math (cart.ts) is the domain logic;
// these functions persist/restore it.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Get or create a Customer's cart for the given Store. Returns the cart id.
 * One cart per customer per store (enforced by a unique index).
 */
export async function getOrCreateDbCart(
  storeId: string,
  customerId: string,
): Promise<string> {
  return tenantClient(storeId, async (tx) => {
    // Try to find existing.
    const existing = await tx.execute(
      sql`SELECT id FROM carts WHERE customer_id = ${customerId} LIMIT 1`,
    );
    if (existing.rows.length > 0) {
      return existing.rows[0]!.id as string;
    }
    // Create new.
    const [cart] = await tx
      .insert(schema.carts)
      .values({ storeId, customerId })
      .returning();
    return cart!.id;
  });
}

/**
 * Load a Customer's cart as a domain Cart object (storeId + lines).
 * Returns an empty cart if the customer has no cart yet.
 */
export async function getDbCart(
  storeId: string,
  customerId: string,
): Promise<Cart> {
  return tenantClient(storeId, async (tx) => {
    const cartRows = await tx.execute(
      sql`SELECT id FROM carts WHERE customer_id = ${customerId} LIMIT 1`,
    );
    if (cartRows.rows.length === 0) {
      return { storeId, lines: [] };
    }
    const cartId = cartRows.rows[0]!.id as string;

    const itemRows = await tx.execute(
      sql`SELECT variant_id, quantity FROM cart_items WHERE cart_id = ${cartId}`,
    );
    return {
      storeId,
      lines: (itemRows.rows as Array<{ variant_id: string; quantity: number }>).map(
        (r) => ({ variantId: r.variant_id, quantity: r.quantity }),
      ),
    };
  });
}

/**
 * Save a cart's lines to the database, replacing any existing items.
 * Used after pure line-math operations are applied to a Cart domain object.
 */
export async function saveDbCartLines(
  storeId: string,
  customerId: string,
  lines: CartLine[],
): Promise<void> {
  await tenantClient(storeId, async (tx) => {
    const cartId = await getOrCreateDbCart(storeId, customerId);

    // Delete existing items.
    await tx
      .delete(schema.cartItems)
      .where(eq(schema.cartItems.cartId, cartId));

    // Insert new items.
    if (lines.length > 0) {
      await tx.insert(schema.cartItems).values(
        lines.map((line) => ({
          storeId,
          cartId,
          variantId: line.variantId,
          quantity: line.quantity,
        })),
      );
    }
  });
}

/**
 * Delete a Customer's cart (and all its items, via cascade).
 */
export async function deleteDbCart(
  storeId: string,
  customerId: string,
): Promise<void> {
  await tenantClient(storeId, async (tx) => {
    await tx
      .delete(schema.carts)
      .where(eq(schema.carts.customerId, customerId));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Checkout + Order lifecycle (Issue #9).
// checkout() converts a Cart into an Order (pending/unfulfilled), snapshots
// unit prices into Order Lines, and consumes the Cart.
// Inventory is NOT decremented here — that's the payment slice (ADR-0002).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Convert a Customer's Cart into an Order.
 *
 * 1. Loads the cart + live variant prices.
 * 2. Creates an Order in payment=pending, fulfillment=unfulfilled.
 * 3. Creates Order Lines with snapshotted unit prices (frozen at checkout).
 * 4. Consumes the Cart (deletes it).
 *
 * Inventory is NOT decremented here — that happens in the payment transaction.
 */
export async function checkout(
  storeId: string,
  customerId: string,
): Promise<{ orderId: string; totalCents: number }> {
  return tenantClient(storeId, async (tx) => {
    // 1. Load cart + prices.
    const cartRows = await tx.execute(
      sql`SELECT id FROM carts WHERE customer_id = ${customerId} LIMIT 1`,
    );
    if (cartRows.rows.length === 0) {
      throw new Error("Cannot checkout: cart is empty or does not exist");
    }
    const cartId = cartRows.rows[0]!.id as string;

    const itemRows = await tx.execute(
      sql`SELECT variant_id, quantity FROM cart_items WHERE cart_id = ${cartId}`,
    );
    const lines = itemRows.rows as Array<{ variant_id: string; quantity: number }>;
    if (lines.length === 0) {
      throw new Error("Cannot checkout: cart has no items");
    }

    // Snapshot live prices for each variant.
    let totalCents = 0;
    const pricedLines: Array<{
      variantId: string;
      quantity: number;
      unitPriceCents: number;
    }> = [];

    for (const line of lines) {
      const priceRows = await tx.execute(
        sql`SELECT price_cents FROM variants WHERE id = ${line.variant_id} LIMIT 1`,
      );
      if (priceRows.rows.length === 0) {
        throw new Error(`Variant ${line.variant_id} not found`);
      }
      const unitPriceCents = priceRows.rows[0]!.price_cents as number;
      totalCents += unitPriceCents * line.quantity;
      pricedLines.push({
        variantId: line.variant_id,
        quantity: line.quantity,
        unitPriceCents,
      });
    }

    // 2. Create the Order (pending/unfulfilled).
    const [order] = await tx
      .insert(schema.orders)
      .values({
        storeId,
        customerId,
        paymentStatus: "pending",
        fulfillmentStatus: "unfulfilled",
        totalCents,
      })
      .returning();

    // 3. Create Order Lines with snapshotted prices.
    for (const line of pricedLines) {
      await tx.insert(schema.orderLines).values({
        storeId,
        orderId: order!.id,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
      });
    }

    // 4. Consume the cart (delete it — cascade removes cart_items).
    await tx.delete(schema.carts).where(eq(schema.carts.id, cartId));

    return { orderId: order!.id, totalCents };
  });
}

/**
 * Load an Order by id (with its lines), scoped to the Current Store via RLS.
 * Returns null if the Order doesn't exist or belongs to another Store.
 */
export async function getOrder(
  storeId: string,
  orderId: string,
): Promise<{
  id: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  totalCents: number;
  lines: Array<{
    variantId: string;
    quantity: number;
    unitPriceCents: number;
  }>;
} | null> {
  return tenantClient(storeId, async (tx) => {
    const orderRows = await tx.execute(
      sql`SELECT id, payment_status, fulfillment_status, total_cents FROM orders WHERE id = ${orderId} LIMIT 1`,
    );
    if (orderRows.rows.length === 0) return null;

    const o = orderRows.rows[0] as {
      id: string;
      payment_status: string;
      fulfillment_status: string;
      total_cents: number;
    };

    const lineRows = await tx.execute(
      sql`SELECT variant_id, quantity, unit_price_cents FROM order_lines WHERE order_id = ${orderId}`,
    );
    const lines = (lineRows.rows as Array<{
      variant_id: string;
      quantity: number;
      unit_price_cents: number;
    }>).map((r) => ({
      variantId: r.variant_id,
      quantity: r.quantity,
      unitPriceCents: r.unit_price_cents,
    }));

    return {
      id: o.id,
      paymentStatus: o.payment_status,
      fulfillmentStatus: o.fulfillment_status,
      totalCents: o.total_cents,
      lines,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Payment transaction + idempotency (Issue #10, ADR-0002).
//
// markOrderPaid() is the concurrency fence: it transitions payment: pending→paid,
// reads the affected Variants FOR UPDATE (row-lock), checks + decrements inventory,
// all atomically inside ONE transaction. No oversell is possible.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Transition an Order to paid and decrement inventory atomically.
 *
 * THE CONCURRENCY FENCE (ADR-0002):
 * 1. Read the Order's lines.
 * 2. SELECT ... FOR UPDATE on each Variant (row-lock — serializes concurrent payments).
 * 3. Check inventory >= quantity for every line.
 *    - If ANY line is insufficient → throw (payment voided). NO decrement happens.
 * 4. Decrement all variants.
 * 5. Transition payment: pending → paid.
 *
 * All in ONE transaction — if step 3 fails, nothing is committed (no partial decrement).
 *
 * Returns true if the transition succeeded, false if the order was already paid
 * (idempotent — safe to call from a replayed webhook).
 */
export async function markOrderPaid(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; reason: "already_paid" | "insufficient_inventory" }> {
  return tenantClient(storeId, async (tx) => {
    // Check current payment status (idempotency).
    const orderRows = await tx.execute(
      sql`SELECT payment_status FROM orders WHERE id = ${orderId} FOR UPDATE`,
    );
    if (orderRows.rows.length === 0) {
      throw new Error(`Order ${orderId} not found`);
    }
    const currentStatus = orderRows.rows[0]!.payment_status as string;
    if (currentStatus === "paid") {
      return { ok: false, reason: "already_paid" };
    }
    if (currentStatus !== "pending") {
      throw new Error(`Order ${orderId} is in unexpected state: ${currentStatus}`);
    }

    // Load order lines.
    const lineRows = await tx.execute(
      sql`SELECT variant_id, quantity FROM order_lines WHERE order_id = ${orderId}`,
    );
    const lines = lineRows.rows as Array<{ variant_id: string; quantity: number }>;

    // Lock + check each variant. FOR UPDATE serializes concurrent payments.
    for (const line of lines) {
      const variantRows = await tx.execute(
        sql`SELECT inventory FROM variants WHERE id = ${line.variant_id} FOR UPDATE`,
      );
      if (variantRows.rows.length === 0) {
        throw new Error(`Variant ${line.variant_id} not found`);
      }
      const inventory = variantRows.rows[0]!.inventory as number;
      if (inventory < line.quantity) {
        // Insufficient inventory — void this payment attempt.
        // NO decrement happens (we haven't written any). The transaction rolls back.
        return { ok: false, reason: "insufficient_inventory" };
      }
    }

    // All checks passed — decrement every variant.
    for (const line of lines) {
      await tx.execute(
        sql`UPDATE variants SET inventory = inventory - ${line.quantity} WHERE id = ${line.variant_id}`,
      );
    }

    // Transition payment: pending → paid.
    await tx.execute(
      sql`UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = ${orderId}`,
    );

    return { ok: true as const };
  });
}

/**
 * Check whether a webhook event has already been processed (idempotency).
 * Returns true if the event id is in the processed_events table.
 */
export async function isEventProcessed(eventId: string): Promise<boolean> {
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id FROM processed_events WHERE id = ${eventId} LIMIT 1`,
    );
    return rows.rows.length > 0;
  });
}

/**
 * Mark a webhook event as processed. Insert is best-effort — if the event is
 * already processed, the PK conflict makes this a no-op.
 */
export async function markEventProcessed(eventId: string): Promise<void> {
  await platformClient(async (tx) => {
    await tx.execute(
      sql`INSERT INTO processed_events (id) VALUES (${eventId}) ON CONFLICT DO NOTHING`,
    );
  });
}

/**
 * Upsert a Store's Stripe Connect account. Called after onboarding completes.
 */
export async function upsertPaymentAccount(opts: {
  storeId: string;
  connectAccountId: string;
  detailsSubmitted?: boolean;
  chargesEnabled?: boolean;
}): Promise<void> {
  await platformClient(async (tx) => {
    await tx.execute(
      sql`
        INSERT INTO stripe_payment_accounts (store_id, connect_account_id, details_submitted, charges_enabled)
        VALUES (${opts.storeId}, ${opts.connectAccountId}, ${opts.detailsSubmitted ?? false}, ${opts.chargesEnabled ?? false})
        ON CONFLICT (store_id) DO UPDATE SET
          connect_account_id = EXCLUDED.connect_account_id,
          details_submitted = EXCLUDED.details_submitted,
          charges_enabled = EXCLUDED.charges_enabled,
          updated_at = now()
      `,
    );
  });
}

/**
 * Get a Store's Stripe Connect account, or null if not yet onboarded.
 */
export async function getPaymentAccount(
  storeId: string,
): Promise<{ connectAccountId: string; detailsSubmitted: boolean; chargesEnabled: boolean } | null> {
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT connect_account_id, details_submitted, charges_enabled FROM stripe_payment_accounts WHERE store_id = ${storeId} LIMIT 1`,
    );
    if (rows.rows.length === 0) return null;
    const r = rows.rows[0] as {
      connect_account_id: string;
      details_submitted: boolean;
      charges_enabled: boolean;
    };
    return {
      connectAccountId: r.connect_account_id,
      detailsSubmitted: r.details_submitted,
      chargesEnabled: r.charges_enabled,
    };
  });
}

/**
 * Get a Store's commission in basis points.
 */
export async function getStoreCommissionBps(storeId: string): Promise<number> {
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT commission_bps FROM stores WHERE id = ${storeId} LIMIT 1`,
    );
    if (rows.rows.length === 0) throw new Error("Store not found");
    return rows.rows[0]!.commission_bps as number;
  });
}

/**
 * Resolve a Store id from a Stripe Connect account id.
 * Used by the webhook handler to find which Store a payment belongs to.
 */
export async function getStoreIdByConnectAccount(
  connectAccountId: string,
): Promise<string | null> {
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT store_id FROM stripe_payment_accounts WHERE connect_account_id = ${connectAccountId} LIMIT 1`,
    );
    if (rows.rows.length === 0) return null;
    return rows.rows[0]!.store_id as string;
  });
}

/**
 * Load an Order with its lines in the shape needed by buildCheckoutSessionParams.
 * Includes product titles for the Stripe line item names.
 */
export async function getOrderForCheckout(
  storeId: string,
  orderId: string,
): Promise<{
  id: string;
  paymentStatus: string;
  totalCents: number;
  lines: Array<{
    variantId: string;
    productTitle: string;
    quantity: number;
    unitPriceCents: number;
  }>;
} | null> {
  return tenantClient(storeId, async (tx) => {
    const orderRows = await tx.execute(
      sql`SELECT id, payment_status, total_cents FROM orders WHERE id = ${orderId} LIMIT 1`,
    );
    if (orderRows.rows.length === 0) return null;
    const o = orderRows.rows[0] as {
      id: string;
      payment_status: string;
      total_cents: number;
    };

    const lineRows = await tx.execute(
      sql`
        SELECT ol.variant_id, ol.quantity, ol.unit_price_cents, p.title as product_title
        FROM order_lines ol
        JOIN variants v ON v.id = ol.variant_id
        JOIN products p ON p.id = v.product_id
        WHERE ol.order_id = ${orderId}
      `,
    );
    const lines = (lineRows.rows as Array<{
      variant_id: string;
      quantity: number;
      unit_price_cents: number;
      product_title: string;
    }>).map((r) => ({
      variantId: r.variant_id,
      productTitle: r.product_title,
      quantity: r.quantity,
      unitPriceCents: r.unit_price_cents,
    }));

    return {
      id: o.id,
      paymentStatus: o.payment_status,
      totalCents: o.total_cents,
      lines,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Collections — Manual + Automated (Issue #11).
//
// Manual collections use an explicit join table.
// Automated collections evaluate their rule at query time (always current).
// Both are tenant-scoped (RLS-protected).
// ─────────────────────────────────────────────────────────────────────────

import type { CollectionRule } from "./collections";

/**
 * Create a collection (manual or automated).
 * For automated, pass a rule jsonb. For manual, omit rule.
 */
export async function createCollection(
  storeId: string,
  opts: {
    name: string;
    slug: string;
    type: "manual" | "automated";
    rule?: CollectionRule;
  },
): Promise<{ id: string; type: string }> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`INSERT INTO collections (name, slug, type, rule) VALUES (${opts.name}, ${opts.slug}, ${opts.type}, ${opts.rule ? JSON.stringify(opts.rule) : null}) RETURNING id, type`,
    );
    const r = rows.rows[0] as { id: string; type: string };
    return { id: r.id, type: r.type };
  });
}

/**
 * List all collections in a Store.
 */
export async function listCollections(
  storeId: string,
): Promise<Array<{ id: string; name: string; slug: string; type: string }>> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, name, slug, type FROM collections ORDER BY created_at DESC`,
    );
    return rows.rows as Array<{ id: string; name: string; slug: string; type: string }>;
  });
}

/**
 * Add products to a manual collection (insert join rows).
 */
export async function addCollectionMembers(
  storeId: string,
  collectionId: string,
  productIds: string[],
): Promise<void> {
  if (productIds.length === 0) return;
  return tenantClient(storeId, async (tx) => {
    for (const productId of productIds) {
      await tx.execute(
        sql`INSERT INTO collection_products (collection_id, product_id) VALUES (${collectionId}, ${productId}) ON CONFLICT DO NOTHING`,
      );
    }
  });
}

/**
 * Remove a product from a manual collection.
 */
export async function removeCollectionMember(
  storeId: string,
  collectionId: string,
  productId: string,
): Promise<void> {
  return tenantClient(storeId, async (tx) => {
    await tx.execute(
      sql`DELETE FROM collection_products WHERE collection_id = ${collectionId} AND product_id = ${productId}`,
    );
  });
}

/**
 * List the members of a collection (manual or automated).
 *
 * For manual: join collection_products → products.
 * For automated: evaluate the rule at query time (always current).
 */
export async function listCollectionMembers(
  storeId: string,
  collectionId: string,
): Promise<Array<{ id: string; title: string; slug: string }>> {
  return tenantClient(storeId, async (tx) => {
    // Look up the collection type + rule.
    const colRows = await tx.execute(
      sql`SELECT type, rule FROM collections WHERE id = ${collectionId} LIMIT 1`,
    );
    if (colRows.rows.length === 0) return [];
    const col = colRows.rows[0] as { type: string; rule: unknown };

    if (col.type === "manual") {
      // Join table.
      const rows = await tx.execute(
        sql`
          SELECT p.id, p.title, p.slug FROM products p
          JOIN collection_products cp ON cp.product_id = p.id
          WHERE cp.collection_id = ${collectionId}
          ORDER BY cp.position, p.title
        `,
      );
      return rows.rows as Array<{ id: string; title: string; slug: string }>;
    }

    // Automated — evaluate the rule.
    const rule = col.rule as CollectionRule | null;
    if (!rule) return [];

    if (rule.type === "tag") {
      const rows = await tx.execute(
        sql`SELECT id, title, slug FROM products WHERE ${rule.tag} = ANY(tags) ORDER BY title`,
      );
      return rows.rows as Array<{ id: string; title: string; slug: string }>;
    }

    // price_range
    const minCents = rule.minCents ?? 0;
    const maxCents = rule.maxCents ?? Number.MAX_SAFE_INTEGER;
    const rows = await tx.execute(
      sql`
        SELECT p.id, p.title, p.slug FROM products p
        WHERE (
          SELECT MIN(v.price_cents) FROM variants v WHERE v.product_id = p.id
        ) BETWEEN ${minCents} AND ${maxCents}
        ORDER BY p.title
      `,
    );
    return rows.rows as Array<{ id: string; title: string; slug: string }>;
  });
}








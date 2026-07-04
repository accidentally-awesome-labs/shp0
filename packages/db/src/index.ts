import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export * as schema from "./schema";
export { parseMoney, formatMoney, applyPercent } from "./money";
export type { Store, NewStore, Membership, NewMembership, Product, NewProduct, Variant, NewVariant } from "./schema";

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




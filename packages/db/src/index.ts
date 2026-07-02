import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export * as schema from "./schema";
export type { Store, NewStore } from "./schema";

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
        created_at timestamptz NOT NULL DEFAULT now()
      );
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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { applySchema } from "../src/index";

/**
 * applySchema() must bootstrap an EMPTY database, and running it again must
 * change nothing.
 *
 * The shared shp0_test database is already bootstrapped by the other suites, so
 * this test gives applySchema() an empty namespace of its own: a throwaway
 * schema, with search_path pinned to it for every connection applySchema()
 * opens. Every unqualified CREATE / REFERENCES then resolves inside that schema
 * and nothing in `public` is visible, exactly as in a new database. (A throwaway
 * database would need CREATEDB, which the test roles deliberately lack.)
 */

const BASE_URL =
  process.env.PLATFORM_DATABASE_URL ??
  "postgresql:///shp0_test?user=cloud_admin";

const SCHEMA = `bootstrap_${randomUUID().replace(/-/g, "")}`;

/**
 * `base` with `-c search_path=<schemaName>` added to its startup `options`.
 * Appends rather than replaces, so options already in the URL (for example a
 * hosted provider's `endpoint=...` routing option) are kept.
 */
function urlWithSearchPath(base: string, schemaName: string): string {
  const url = new URL(base);
  const searchPath = `-c search_path=${schemaName}`;
  const existing = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    existing ? `${existing} ${searchPath}` : searchPath,
  );
  return url.toString();
}

const SCOPED_URL = urlWithSearchPath(BASE_URL, SCHEMA);

const KEY_TABLES = [
  "stores",
  "memberships",
  "user",
  "session",
  "account",
  "verification",
  "products",
  "variants",
  "carts",
  "cart_items",
  "orders",
  "order_lines",
  "collections",
  "collection_products",
  "discounts",
  "discount_redemptions",
  "customers",
  "customer_sessions",
  "addresses",
  "subscriptions",
  "custom_domains",
  "stripe_payment_accounts",
  "processed_events",
];

/** Everything applySchema() defines in the schema, by definition (not by OID). */
async function snapshot(pool: Pool) {
  const q = async (text: string) =>
    (await pool.query(text, [SCHEMA])).rows as Array<Record<string, unknown>>;
  return {
    tables: await q(`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
      ORDER BY c.relname`),
    columns: await q(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, column_name`),
    constraints: await q(`
      SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      ORDER BY c.relname, con.conname`),
    indexes: await q(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = $1
      ORDER BY tablename, indexname`),
    policies: await q(`
      SELECT tablename, policyname, cmd, roles::text, qual, with_check
      FROM pg_policies
      WHERE schemaname = $1
      ORDER BY tablename, policyname`),
    triggers: await q(`
      SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal
      ORDER BY c.relname, t.tgname`),
    functions: await q(`
      SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
      ORDER BY p.proname`),
    grants: await q(`
      SELECT table_name, grantee, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = $1
      ORDER BY table_name, grantee, privilege_type`),
  };
}

describe("applySchema() bootstraps an empty database", () => {
  let admin: Pool;
  let scoped: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: BASE_URL });
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    scoped = new Pool({ connectionString: SCOPED_URL });
  });

  afterAll(async () => {
    await scoped?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin?.end();
  });

  it("creates every table, including memberships' foreign key to \"user\", and a second run changes nothing", async () => {
    // The namespace really is empty, and applySchema() sees only it.
    const before = await scoped.query(
      `SELECT count(*)::int AS n FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`,
      [SCHEMA],
    );
    expect(before.rows[0].n).toBe(0);
    const visible = await scoped.query(`SELECT to_regclass('stores') AS t`);
    expect(visible.rows[0].t).toBeNull();

    await applySchema(SCOPED_URL);
    const first = await snapshot(scoped);

    const tables = first.tables.map((t) => t.relname);
    expect(tables).toEqual(expect.arrayContaining(KEY_TABLES));

    const membershipFks = first.constraints
      .filter((c) => c.relname === "memberships" && String(c.def).startsWith("FOREIGN KEY"))
      .map((c) => c.def);
    expect(membershipFks).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^FOREIGN KEY \(user_id\) REFERENCES "user"\(id\)/),
        expect.stringMatching(/^FOREIGN KEY \(store_id\) REFERENCES stores\(id\)/),
      ]),
    );

    // Idempotent: applying again to the bootstrapped schema succeeds and
    // leaves every definition exactly as it was.
    await applySchema(SCOPED_URL);
    const second = await snapshot(scoped);
    expect(second).toEqual(first);
  });
});

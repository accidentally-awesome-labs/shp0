import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { applySchema } from "../src/index";
import { BASE_URL, urlWithSearchPath } from "./scoped-schema";

/**
 * applySchema() must bootstrap an EMPTY database, and running it again must
 * change nothing.
 *
 * The shared shp0_test database is already bootstrapped by the other suites, so
 * this test gives applySchema() an empty namespace of its own: a throwaway
 * schema, with search_path pinned to it for every connection applySchema()
 * opens (./scoped-schema). Every unqualified CREATE / REFERENCES then resolves
 * inside that schema and nothing in `public` is visible, exactly as in a new
 * database.
 */

const SCHEMA = `bootstrap_${randomUUID().replace(/-/g, "")}`;

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

/** The two Membership constraints, by name and definition. */
const MEMBERSHIP_CONSTRAINTS = [
  {
    conname: "memberships_role_check",
    def: "CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text])))",
  },
  { conname: "memberships_user_store_key", def: "UNIQUE (user_id, store_id)" },
];

/**
 * The single-Owner triggers on memberships, by name and definition (the
 * table's schema written as <schema>): the owner-delete trigger, and the
 * constraint trigger that checks at COMMIT that a Store whose Owner row
 * changed still has exactly one Owner.
 */
const OWNER_TRIGGERS = [
  {
    tgname: "memberships_exactly_one_owner",
    def:
      "CREATE CONSTRAINT TRIGGER memberships_exactly_one_owner AFTER DELETE OR UPDATE ON <schema>.memberships " +
      "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.role = 'owner'::text)) " +
      "EXECUTE FUNCTION memberships_check_exactly_one_owner()",
  },
  {
    tgname: "memberships_no_delete_owner",
    def:
      "CREATE TRIGGER memberships_no_delete_owner BEFORE DELETE ON <schema>.memberships " +
      "FOR EACH ROW EXECUTE FUNCTION memberships_prevent_owner_delete()",
  },
];

/** memberships' triggers, by name and definition, from a snapshot of `schemaName`. */
function membershipTriggers(snap: Awaited<ReturnType<typeof snapshot>>, schemaName: string) {
  return withoutSchemaName(snap, schemaName)
    .triggers.filter((t) => t.relname === "memberships")
    .map((t) => ({ tgname: t.tgname, def: t.def }));
}

function membershipConstraints(constraints: Array<Record<string, unknown>>) {
  return constraints
    .filter(
      (c) =>
        c.relname === "memberships" &&
        MEMBERSHIP_CONSTRAINTS.some((m) => m.conname === c.conname),
    )
    .map((c) => ({ conname: c.conname, def: c.def }));
}

/**
 * A snapshot with the schema's own name taken out, so two schemas can be
 * compared: index and trigger definitions name their table schema-qualified.
 */
function withoutSchemaName(snap: Awaited<ReturnType<typeof snapshot>>, schemaName: string) {
  return JSON.parse(JSON.stringify(snap).split(`${schemaName}.`).join("<schema>.")) as typeof snap;
}

/** Everything applySchema() defines in the schema, by definition (not by OID). */
async function snapshot(pool: Pool, schemaName: string = SCHEMA) {
  const q = async (text: string) =>
    (await pool.query(text, [schemaName])).rows as Array<Record<string, unknown>>;
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
      SELECT p.proname, p.prosrc, p.proconfig
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

    // One Membership per person per Store, and only the three Roles.
    expect(membershipConstraints(first.constraints)).toEqual(MEMBERSHIP_CONSTRAINTS);

    // Exactly one Owner per Store: the owner row cannot be deleted, and a
    // transaction that leaves a Store without its Owner is refused at COMMIT.
    expect(membershipTriggers(first, SCHEMA)).toEqual(OWNER_TRIGGERS);
    expect(
      first.constraints.filter((c) => c.relname === "memberships" && c.conname === "memberships_exactly_one_owner"),
    ).toEqual([
      {
        relname: "memberships",
        conname: "memberships_exactly_one_owner",
        def: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
      },
    ]);
    // Its function takes neither search_path nor row-level security from
    // the committing session.
    expect(
      first.functions
        .filter((f) => f.proname === "memberships_check_exactly_one_owner")
        .map((f) => f.proconfig),
    ).toEqual([["search_path=pg_catalog, pg_temp", "row_security=off"]]);

    // Idempotent: applying again to the bootstrapped schema succeeds and
    // leaves every definition exactly as it was.
    await applySchema(SCOPED_URL);
    const second = await snapshot(scoped);
    expect(second).toEqual(first);
  });

  it("the COMMIT-time Owner check counts the Owner rows of its own schema, whatever the session's search_path", async () => {
    await applySchema(SCOPED_URL);
    const storeId = randomUUID();
    await scoped.query(`INSERT INTO "user" (id, name, email) VALUES ('owner', 'Owner', 'owner@bootstrap.test')`);
    await scoped.query(
      `INSERT INTO stores (id, store_id, name, subdomain) VALUES ($1, $1, 'Scoped', 'scoped')`,
      [storeId],
    );
    await scoped.query(`INSERT INTO memberships (user_id, store_id, role) VALUES ('owner', $1, 'owner')`, [
      storeId,
    ]);

    // `admin` has the default search_path, where `stores` is public.stores:
    // that table has no row for this Store.
    await expect(
      admin.query(`UPDATE "${SCHEMA}".memberships SET role = 'admin' WHERE store_id = $1`, [storeId]),
    ).rejects.toMatchObject({
      code: "23000",
      constraint: "memberships_exactly_one_owner",
      schema: SCHEMA,
      table: "memberships",
    });
    const owners = await scoped.query(`SELECT user_id FROM memberships WHERE role = 'owner'`);
    expect(owners.rows).toEqual([{ user_id: "owner" }]);
  });
});

/**
 * applySchema() over a database that an older applySchema() created, before
 * memberships had its two constraints and the exactly-one-Owner trigger.
 * Postgres has no ADD CONSTRAINT IF NOT EXISTS, so applySchema() adds each
 * constraint only when it is missing; when rows already break them it stops
 * with an error and changes no row. The trigger checks only later changes to
 * an Owner row, so adding it never fails on existing rows.
 *
 * The older database is made by bootstrapping a throwaway schema and dropping
 * the two constraints and the trigger (with its function): they are the only
 * difference in memberships' definition.
 */
describe("applySchema() upgrades a database created before the Membership constraints", () => {
  const OLD = `upgrade_${randomUUID().replace(/-/g, "")}`;
  const FRESH = `fresh_${randomUUID().replace(/-/g, "")}`;
  const OLD_URL = urlWithSearchPath(BASE_URL, OLD);
  const FRESH_URL = urlWithSearchPath(BASE_URL, FRESH);
  const STORE = randomUUID();
  const OWNERLESS_STORE = randomUUID();
  let admin: Pool;
  let old: Pool;
  let fresh: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: BASE_URL });
    await admin.query(`CREATE SCHEMA "${FRESH}"`);
    old = new Pool({ connectionString: OLD_URL });
    fresh = new Pool({ connectionString: FRESH_URL });
  });

  afterAll(async () => {
    await old?.end();
    await fresh?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${OLD}" CASCADE`);
    await admin?.query(`DROP SCHEMA IF EXISTS "${FRESH}" CASCADE`);
    await admin?.end();
  });

  /**
   * A new throwaway schema as an older applySchema() left it, holding these
   * Memberships ([user id, role text, Store]; user ids double as names).
   */
  async function olderDatabaseWith(
    memberships: Array<[userId: string, role: string, store?: string]>,
  ): Promise<void> {
    await admin.query(`DROP SCHEMA IF EXISTS "${OLD}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${OLD}"`);
    await applySchema(OLD_URL);
    await old.query(`
      ALTER TABLE memberships
        DROP CONSTRAINT IF EXISTS memberships_user_store_key,
        DROP CONSTRAINT IF EXISTS memberships_role_check`);
    await old.query(`
      DROP TRIGGER IF EXISTS memberships_exactly_one_owner ON memberships;
      DROP FUNCTION IF EXISTS memberships_check_exactly_one_owner()`);
    const older = await snapshot(old, OLD);
    expect(membershipConstraints(older.constraints)).toEqual([]);
    expect(membershipTriggers(older, OLD)).toEqual(
      OWNER_TRIGGERS.filter((t) => t.tgname === "memberships_no_delete_owner"),
    );

    await old.query(
      `INSERT INTO stores (id, store_id, name, subdomain)
       VALUES ($1, $1, 'Old', 'old'), ($2, $2, 'Ownerless', 'ownerless')`,
      [STORE, OWNERLESS_STORE],
    );
    for (const userId of new Set(memberships.map(([userId]) => userId))) {
      await old.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $1, $1 || '@upgrade.test')`, [
        userId,
      ]);
    }
    // One minute apart, in the order given, so "oldest first" is well defined.
    for (const [minute, [userId, role, store = STORE]] of memberships.entries()) {
      await old.query(
        `INSERT INTO memberships (user_id, store_id, role, created_at)
         VALUES ($1, $2, $3, timestamptz '2026-01-01 00:00Z' + make_interval(mins => $4))`,
        [userId, store, role, minute],
      );
    }
  }

  async function allMemberships() {
    return (await old.query(`SELECT * FROM memberships ORDER BY created_at`)).rows;
  }

  /** Memberships that break one constraint or the other, or both. */
  const VIOLATIONS: Array<[userId: string, role: string, store?: string]> = [
    ["owner", "owner"],
    ["owner", "Owner"], // the Owner again, mis-cased
    ["promoted", "Admin"], // an Admin, mis-cased
    ["twice", "staff"], // two Roles in one Store
    ["twice", "admin"],
    ["impostor", "Owner"], // owner-like text, in a Store that has its Owner
    ["junk", "garbage"],
    ["blank", ""],
    ["heir", "OWNER", OWNERLESS_STORE], // owner-like text, in a Store with no Owner
  ];

  it("adds both constraints when every row keeps to them, changes no row, and ends exactly like a fresh bootstrap", async () => {
    await olderDatabaseWith([
      ["owner", "owner"],
      ["admin", "admin"],
      ["staff", "staff"],
      ["staff", "admin", OWNERLESS_STORE],
    ]);
    const before = await allMemberships();

    await applySchema(OLD_URL);
    expect(await allMemberships()).toEqual(before);
    const upgraded = await snapshot(old, OLD);
    expect(membershipConstraints(upgraded.constraints)).toEqual(MEMBERSHIP_CONSTRAINTS);
    expect(membershipTriggers(upgraded, OLD)).toEqual(OWNER_TRIGGERS);

    await applySchema(FRESH_URL);
    expect(withoutSchemaName(upgraded, OLD)).toEqual(
      withoutSchemaName(await snapshot(fresh, FRESH), FRESH),
    );

    // A second run over the upgraded database changes nothing.
    await applySchema(OLD_URL);
    expect(await snapshot(old, OLD)).toEqual(upgraded);
  });

  it("stops with an error naming the rows that break them, and changes no row", async () => {
    await olderDatabaseWith(VIOLATIONS);
    const before = await allMemberships();

    const error = await applySchema(OLD_URL).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/memberships_user_store_key/);
    expect(message).toMatch(/memberships_role_check/);
    expect(message).toMatch(/No Membership row was changed or deleted/);
    // The person-Store pairs with several rows...
    expect(message).toMatch(/2 people have several Memberships in one Store/);
    expect(message).toMatch(new RegExp(`user_id="twice" store_id=${STORE} roles=\\["staff","admin"\\]`));
    expect(message).toMatch(new RegExp(`user_id="owner" store_id=${STORE} roles=\\["owner","Owner"\\]`));
    // ...and every row whose role text is not a Role.
    expect(message).toMatch(/6 Memberships have role text other than/);
    for (const [userId, role] of VIOLATIONS.filter(([, role]) => !["owner", "admin", "staff"].includes(role))) {
      expect(message).toContain(`user_id=${JSON.stringify(userId)}`);
      expect(message).toContain(`role=${JSON.stringify(role)}`);
    }

    expect(await allMemberships()).toEqual(before);
    expect(membershipConstraints((await snapshot(old, OLD)).constraints)).toEqual([]);
  });

  /**
   * A one-off cleanup of the kind the error asks for, run by hand in one
   * transaction: lowercase role text (owner-like text only in a Store with no
   * Owner, so there is never a second Owner); keep one row per person per
   * Store, the highest valid Role (the Store's Owner row always ranks first,
   * and the owner-delete trigger would refuse to remove it); then remove role
   * text that is still not a Role, which grants nothing today
   * (getMembershipRole fails closed on it).
   *
   * Promoting owner-like text makes that person the Store's Owner, up from no
   * access today, so the operator first previews exactly who
   * (NEW_OWNERS_PREVIEW, the same condition as the UPDATE after it). These
   * are the statements the PR's cleanup script runs, without its other
   * previews.
   */
  const NEW_OWNERS_PREVIEW = `SELECT store_id, user_id, role FROM memberships m
     WHERE role <> 'owner' AND lower(btrim(role)) = 'owner'
       AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.store_id = m.store_id AND o.role = 'owner')
     ORDER BY store_id, created_at, id`;
  const CLEANUP = [
    `LOCK TABLE memberships IN SHARE ROW EXCLUSIVE MODE`,
    `UPDATE memberships SET role = lower(btrim(role))
     WHERE role NOT IN ('owner', 'admin', 'staff')
       AND lower(btrim(role)) IN ('admin', 'staff')`,
    NEW_OWNERS_PREVIEW,
    `UPDATE memberships m SET role = 'owner'
     WHERE role <> 'owner' AND lower(btrim(role)) = 'owner'
       AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.store_id = m.store_id AND o.role = 'owner')`,
    `DELETE FROM memberships m
     USING (
       SELECT id, row_number() OVER (
         PARTITION BY user_id, store_id
         ORDER BY CASE role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 WHEN 'staff' THEN 1 ELSE 0 END DESC,
                  created_at, id
       ) AS n
       FROM memberships
     ) ranked
     WHERE m.id = ranked.id AND ranked.n > 1`,
    `DELETE FROM memberships WHERE role NOT IN ('owner', 'admin', 'staff')`,
  ];

  it("adds them once the rows are cleaned up by hand; that cleanup keeps the highest valid Role and the Owner row", async () => {
    await olderDatabaseWith(VIOLATIONS);
    const ownerRow = (await allMemberships()).find((m) => m.user_id === "owner" && m.role === "owner");

    let newOwners: unknown[] = [];
    const client = await old.connect();
    try {
      await client.query("BEGIN");
      for (const statement of CLEANUP) {
        const result = await client.query(statement);
        if (statement === NEW_OWNERS_PREVIEW) newOwners = result.rows;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Only 'OWNER' in the Store with no Owner is promoted: 'Owner' in a Store
    // that has its Owner (the Owner's own second row, and "impostor") is not.
    expect(newOwners).toEqual([{ store_id: OWNERLESS_STORE, user_id: "heir", role: "OWNER" }]);

    await applySchema(OLD_URL);
    expect(membershipConstraints((await snapshot(old, OLD)).constraints)).toEqual(MEMBERSHIP_CONSTRAINTS);
    const after = await allMemberships();
    expect(after.map((m) => [m.user_id, m.role, m.store_id])).toEqual([
      ["owner", "owner", STORE],
      ["promoted", "admin", STORE],
      ["twice", "admin", STORE],
      ["heir", "owner", OWNERLESS_STORE],
    ]);
    // The very same Owner row, not a copy.
    expect(after[0]).toEqual(ownerRow);
  });
});

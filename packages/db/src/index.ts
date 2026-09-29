import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { eq, sql, and, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export * as schema from "./schema";
export { parseMoney, formatMoney, applyPercent } from "./money";
export {
  addLine,
  updateLine,
  removeLine,
  computeSubtotal,
  mergeCarts,
  MAX_LINE_QUANTITY,
  isValidLineQuantity,
  parseCartChange,
  applyCartChange,
  priceCartForCheckout,
  cartChangeRejectionMessage,
  checkoutRejectionMessage,
  CheckoutError,
} from "./cart";
export type {
  Cart,
  CartLine,
  CartChange,
  CartChangeRejection,
  CartChangeResult,
  ParsedCartChange,
  CheckoutVariant,
  CheckoutLineProblem,
  CheckoutRejection,
  PricedCart,
} from "./cart";
export { isUuid } from "./ids";
export { transitionPayment, transitionFulfillment, isOrderOpen } from "./order";
export type { PaymentStatus, FulfillmentStatus } from "./order";
export { matchesRule } from "./collections";
export type { CollectionRule, ProductForRule } from "./collections";
export { applyDiscounts } from "./discounts";
export type { DiscountCart, DiscountReward, DiscountResult } from "./discounts";
export { checkUsagePolicy, TIERS } from "./billing";
export type { Tier, TierLimits, Usage, UsageAction, UsagePolicy } from "./billing";
export { transitionStoreStatus } from "./store-status";
export type { StoreStatus, StoreEvent, StoreStatusResult } from "./store-status";
export {
  PLATFORM_DOMAIN,
  parseSubdomain,
  normalizeRequestHost,
  isPlatformHost,
  validateCustomDomain,
  customDomainRejectionMessage,
  routeStorefrontHost,
  storefrontOrigin,
  InvalidCustomDomainError,
} from "./hostname";
export type { CustomDomainRejection, CustomDomainValidation, StorefrontHostRoute } from "./hostname";
export { transitionDomainVerification } from "./domain-verification";
export type {
  DomainVerificationStatus,
  DomainVerificationEvent,
  DomainVerificationResult,
} from "./domain-verification";
export { hashPassword, verifyPassword } from "./customer-auth";
export {
  ROLES,
  ROLE_LABEL,
  CAPABILITY_MINIMUM_ROLE,
  parseRole,
  roleRank,
  hasAtLeastRole,
  isCapability,
  minimumRole,
  can,
  decideStoreAccess,
} from "./roles";
export type { Role, Capability, StoreAccessDecision } from "./roles";
export type { Customer, NewCustomer } from "./schema";
export type { Store, NewStore, Membership, NewMembership, Product, NewProduct, Variant, NewVariant, CartRow, NewCart, CartItem, NewCartItem, Order, NewOrder, OrderLine, NewOrderLine, Collection, NewCollection } from "./schema";
import type { Cart, CartChange, CartChangeResult, CartLine, CheckoutVariant } from "./cart";
import { applyCartChange, CheckoutError, parseCartChange, priceCartForCheckout } from "./cart";
import { isUuid, UUID_PATTERN as UUID } from "./ids";
import { effectiveRole } from "./roles";
import type { Role } from "./roles";

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
 * Which client callback, if any, the current async call chain is running in.
 *
 * Both pools keep pg's default size (10 connections) and are shared by every
 * Store. A callback that opens another client holds one connection while it
 * waits for a second: ten such calls at once take every connection and then
 * wait forever for an eleventh, which wedges the pool for all Stores (a burst
 * of add-to-cart requests did exactly this). So nesting is refused outright,
 * on the first call and not only under load: work inside a callback uses the
 * `tx` it was given, through helpers that take a Tx.
 */
const openClient = new AsyncLocalStorage<string>();

function refuseNestedClient(name: string): void {
  const outer = openClient.getStore();
  if (outer !== undefined) {
    throw new Error(
      `${name}() was called inside another database client (a ${outer}() callback). ` +
        "That holds two pool connections at once and deadlocks the shared pool under load: " +
        "use the transaction the outer callback was given (pass its tx to a helper).",
    );
  }
}

/**
 * Run `fn` against the current Store's data, scoped by the database itself.
 *
 * `app.store_id` is set with `SET LOCAL` inside a transaction, so the GUC is
 * structurally inseparable from the query and resets at COMMIT. RLS policies
 * enforce `current_setting('app.store_id', true) = store_id`; with the GUC unset
 * the policy matches zero rows (fail-closed). This is the only tenant query path.
 *
 * `fn` must not open another client (tenantClient or platformClient, directly
 * or through an exported function): that throws, see refuseNestedClient.
 */
export async function tenantClient<T>(
  storeId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  refuseNestedClient("tenantClient");
  const client = await getTenantPool().connect();
  try {
    await client.query("BEGIN");
    // set_config(..., true) sets a transaction-local GUC (== SET LOCAL) and,
    // unlike SET, accepts a bind parameter — so the store id is never string-built.
    await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    const tx = drizzle(client, { schema });
    const result = await openClient.run("tenantClient", () => fn(tx));
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
 *
 * Like tenantClient, `fn` runs in one transaction: every write it makes
 * commits together when it returns, or none does when it throws (the
 * error is rethrown). No other connection sees those writes before `fn`
 * returns, and a database error aborts the transaction, so `fn` must not
 * catch one and carry on (every later statement would fail with 25P02);
 * use a SAVEPOINT for a statement that may fail. Checks the schema defers
 * to COMMIT (a new Store's Owner, stores_exactly_one_owner_at_creation; an
 * Owner row's changes, memberships_exactly_one_owner) run after `fn`
 * returns, and their refusal rejects this call.
 *
 * Like tenantClient, `fn` must not open another client.
 */
export async function platformClient<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  refuseNestedClient("platformClient");
  const client = await getPlatformPool().connect();
  try {
    await client.query("BEGIN");
    const tx = drizzle(client, { schema });
    const result = await openClient.run("platformClient", () => fn(tx));
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
 * Add memberships' two constraints to a database that an older applySchema()
 * created without them: memberships_user_store_key (one Membership per
 * person per Store) and memberships_role_check (role text is exactly
 * 'owner', 'admin' or 'staff'; this also closes the gap a mis-cased 'Owner'
 * left in the single-Owner index and the owner-delete trigger, which match
 * role = 'owner' exactly). A fresh database has both from CREATE TABLE, and
 * then this only reads pg_constraint.
 *
 * Postgres has no ADD CONSTRAINT IF NOT EXISTS, so a DO block adds each one
 * only when pg_constraint lacks it. Existing rows that break them are never
 * rewritten or deleted here: with memberships locked, any such rows are
 * listed in the error thrown and the transaction rolls back, so a person
 * decides what each row becomes.
 */
async function addMembershipConstraints(client: PoolClient): Promise<void> {
  const present = await client.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM pg_constraint
    WHERE conrelid = 'memberships'::regclass
      AND conname IN ('memberships_user_store_key', 'memberships_role_check')
  `);
  if (present.rows[0]!.n === 2) return;

  await client.query("BEGIN");
  try {
    // The ALTER TABLE below takes this lock anyway. Taking it first means no
    // row changes between the check and the constraints, and no lock upgrade
    // mid-transaction that could deadlock with a concurrent reader.
    await client.query("LOCK TABLE memberships IN ACCESS EXCLUSIVE MODE");
    const violations = await describeMembershipViolations(client);
    if (violations !== null) throw new Error(violations);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'memberships'::regclass AND conname = 'memberships_user_store_key'
        ) THEN
          ALTER TABLE memberships
            ADD CONSTRAINT memberships_user_store_key UNIQUE (user_id, store_id);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'memberships'::regclass AND conname = 'memberships_role_check'
        ) THEN
          ALTER TABLE memberships
            ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'staff'));
        END IF;
      END
      $$;
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** How many offending rows an error lists before "...and N more". */
const LISTED_VIOLATIONS = 20;

/**
 * The error message for memberships rows that break memberships_user_store_key
 * or memberships_role_check, or null when there are none.
 */
async function describeMembershipViolations(client: PoolClient): Promise<string | null> {
  const duplicates = await client.query<{
    user_id: string;
    store_id: string;
    roles: string[];
    total: number;
  }>(
    `SELECT user_id, store_id::text AS store_id,
            array_agg(role ORDER BY created_at, id) AS roles,
            count(*) OVER ()::int AS total
     FROM memberships
     GROUP BY user_id, store_id
     HAVING count(*) > 1
     ORDER BY store_id, user_id
     LIMIT $1`,
    [LISTED_VIOLATIONS],
  );
  const invalid = await client.query<{
    user_id: string;
    store_id: string;
    role: string;
    total: number;
  }>(
    `SELECT user_id, store_id::text AS store_id, role, count(*) OVER ()::int AS total
     FROM memberships
     WHERE role NOT IN ('owner', 'admin', 'staff')
     ORDER BY store_id, user_id, created_at, id
     LIMIT $1`,
    [LISTED_VIOLATIONS],
  );
  if (duplicates.rows.length === 0 && invalid.rows.length === 0) return null;

  const more = (listed: number, total: number) =>
    total > listed ? [`  ...and ${total - listed} more`] : [];
  const lines = [
    "applySchema: cannot add the memberships constraints, because existing rows break them. " +
      "No Membership row was changed or deleted.",
  ];
  if (duplicates.rows.length > 0) {
    const total = duplicates.rows[0]!.total;
    lines.push(
      "",
      `memberships_user_store_key (one Membership per person per Store): ${total} ` +
        `${total === 1 ? "person has" : "people have"} several Memberships in one Store:`,
      ...duplicates.rows.map(
        (d) =>
          `  user_id=${JSON.stringify(d.user_id)} store_id=${d.store_id} roles=${JSON.stringify(d.roles)}`,
      ),
      ...more(duplicates.rows.length, total),
    );
  }
  if (invalid.rows.length > 0) {
    const total = invalid.rows[0]!.total;
    lines.push(
      "",
      `memberships_role_check (role is exactly 'owner', 'admin' or 'staff'): ${total} ` +
        `${total === 1 ? "Membership has" : "Memberships have"} role text other than 'owner', 'admin' or 'staff':`,
      ...invalid.rows.map(
        (r) =>
          `  user_id=${JSON.stringify(r.user_id)} store_id=${r.store_id} role=${JSON.stringify(r.role)}`,
      ),
      ...more(invalid.rows.length, total),
    );
  }
  lines.push(
    "",
    "Fix these rows by hand, in one transaction, then run applySchema again: lowercase the " +
      "role text (never making a second Owner in a Store); keep one row per person per Store, the " +
      "one with the highest valid Role, never removing a Store's Owner row; and decide what each " +
      "row that is still not a Role becomes (such a row grants no access today). In a throwaway " +
      "test database, TRUNCATE memberships (or recreate the database) instead.",
  );
  return lines.join("\n");
}

/**
 * Apply the schema + RLS roles/policies. Idempotent. Run as `cloud_admin`.
 *
 * Must bootstrap an empty database: every table is created after the tables its
 * foreign keys reference. `connectionString` defaults to the platform URL; the
 * bootstrap test passes one pinned to a throwaway schema.
 *
 * The tenant bootstrap `stores` table has no stamping trigger: the platform
 * creates Stores (so the per-request GUC is not set then), and the inserting
 * code sets `store_id = id` itself (see provisionStore()).
 *
 * Over a database an older applySchema() created, it throws, changing no
 * Membership row, when memberships holds rows its constraints refuse (see
 * addMembershipConstraints()).
 */
export async function applySchema(
  connectionString: string = PLATFORM_DATABASE_URL,
): Promise<void> {
  const pool = new Pool({ connectionString });
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

    // ── better-auth core tables (PLATFORM tables — no store_id, no RLS) ──
    // Created before memberships, whose user_id references "user"(id).
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

    // ── memberships (PLATFORM table — bridges global users to Stores) ──
    // One Membership per person per Store, holding exactly one of the three
    // Roles. A database created before these two constraints gets them from
    // addMembershipConstraints() below.
    await client.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        role text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT memberships_user_store_key UNIQUE (user_id, store_id),
        CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'staff'))
      );
    `);
    await addMembershipConstraints(client);
    // Single-Owner invariant, in four parts. Ownership transfer (not
    // implemented yet) passes all four, and must keep one Membership per
    // person per Store: to a person with no Membership in the Store, UPDATE
    // the owner row's user_id; to an existing member, in one transaction,
    // first demote the owner row to 'admin' or 'staff', then promote the
    // member's row to 'owner' (the other order trips the index in part 1).
    // An UPDATE of user_id onto an existing member trips
    // memberships_user_store_key. After the transfer commits, or later in
    // the same transaction, the old Owner's row can be deleted like any
    // other Membership.
    //
    // Part 1: at most one owner per Store.
    await client.query(`
      DROP INDEX IF EXISTS memberships_one_owner_per_store;
      CREATE UNIQUE INDEX memberships_one_owner_per_store
        ON memberships(store_id) WHERE role = 'owner';
    `);
    // Part 2: the owner row cannot be deleted, at once, whatever else the
    // transaction does. This also refuses the cascade that deleting the
    // Store, or the Owner's user (closing their account), runs over the
    // owner row. Part 3 alone would refuse the latter too, but let a Store
    // deletion through (owner-invariant.test.ts shows both with this
    // trigger disabled).
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
    // Part 3: no Store is left without its owner, checked at COMMIT. Whenever
    // a transaction updates or deletes an owner row (demotes it, moves it to
    // another Store, gives it to another person), the Store it was the
    // Owner of must have exactly one owner row when the transaction commits,
    // unless that Store row no longer exists (a Store deleted in the same
    // transaction; part 2 still refuses that while the owner row is in it).
    // Deferred, so a transfer can demote and then promote in two statements;
    // a transaction that leaves the Store without an Owner is refused at
    // COMMIT (SQLSTATE 23000, constraint memberships_exactly_one_owner) and
    // rolls back whole. Promotions need no check here: part 1 refuses a
    // second owner at once.
    //
    // No lock is taken beyond the rows the transaction changed. By part 1 a
    // Store has at most one live owner row; a transaction this fires for has
    // changed it and holds its row lock until it ends, and any other
    // transaction that changes that row, or makes another row the Store's
    // owner, waits for it (for the row lock, or in part 1's uniqueness
    // check). So the two are checked one after the other, and under READ
    // COMMITTED the later one's count, run at its COMMIT with a fresh
    // snapshot, sees what the earlier one committed. owner-invariant.test.ts
    // runs those interleavings on two connections.
    //
    // The check takes nothing from the committing session. It names both
    // tables through the trigger's own schema (TG_TABLE_SCHEMA; stores sits
    // beside memberships), so neither a temporary table nor another schema
    // on the session's search_path can stand in for them; its own
    // search_path is pinned for everything else. row_security = off makes a
    // Store that RLS would hide an error rather than a skipped check. Only
    // cloud_admin (the owner of both tables, so RLS on stores does not apply
    // to it) changes memberships today; "default" has no grant on it.
    //
    // Row triggers do not fire on TRUNCATE, so neither part 2 nor part 3
    // sees TRUNCATE memberships, or a TRUNCATE ... CASCADE of "user" that
    // reaches it: either removes every owner row unchecked. Test fixtures do
    // this; the application must never truncate these tables.
    await client.query(`
      CREATE OR REPLACE FUNCTION memberships_check_exactly_one_owner()
      RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      SET row_security = off
      AS $func$
      DECLARE
        store_exists boolean;
        owners integer;
      BEGIN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.stores WHERE id = $1)', TG_TABLE_SCHEMA)
          INTO store_exists USING OLD.store_id;
        IF NOT store_exists THEN
          RETURN NULL;
        END IF;
        EXECUTE format('SELECT count(*) FROM %I.%I WHERE store_id = $1 AND role = %L',
                       TG_TABLE_SCHEMA, TG_TABLE_NAME, 'owner')
          INTO owners USING OLD.store_id;
        IF owners <> 1 THEN
          RAISE EXCEPTION 'Store % must have exactly one Owner; this transaction leaves it with %.',
            OLD.store_id, owners
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = TG_NAME,
                  SCHEMA = TG_TABLE_SCHEMA,
                  TABLE = TG_TABLE_NAME,
                  HINT = 'Transfer ownership in one transaction: demote the Owner''s Membership, '
                    || 'then promote the new Owner''s; or give the Owner''s Membership to a person '
                    || 'with no Membership in the Store.';
        END IF;
        RETURN NULL;
      END;
      $func$;
    `);
    // CREATE OR REPLACE TRIGGER does not apply to constraint triggers.
    await client.query(`
      DROP TRIGGER IF EXISTS memberships_exactly_one_owner ON memberships;
      CREATE CONSTRAINT TRIGGER memberships_exactly_one_owner
        AFTER UPDATE OR DELETE ON memberships
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (OLD.role = 'owner')
        EXECUTE FUNCTION memberships_check_exactly_one_owner();
    `);
    // Part 4: a new Store has exactly one Owner, checked at COMMIT. Every
    // Store a transaction inserts must have exactly one owner row when the
    // transaction commits, unless that Store row no longer exists (deleted
    // in the same transaction). Deferred, because the owner row can only
    // be inserted after the Store row it references: provisionStore
    // inserts both in the one transaction platformClient opens. A
    // transaction that commits a new Store without its Owner is refused
    // (SQLSTATE 23000, constraint stores_exactly_one_owner_at_creation)
    // and rolls back whole. After creation, parts 1 to 3 keep the Owner.
    //
    // A Store with no Membership can still be given another id (memberships'
    // foreign key refuses that once the Store has any Membership; nothing
    // in the application changes stores.id). The Store under its new id is
    // a new Store, so an UPDATE that changes id is checked like an INSERT,
    // under the new id: a transaction cannot insert a Store and move it to
    // another id to skip the check. An UPDATE that names id but keeps it is
    // not checked.
    //
    // It checks only an INSERT and a change of id, so existing Stores,
    // ownerless ones included, are not checked unless their id changes, and
    // an upgrade cannot fail on them. This read-only query lists the Stores
    // that do not have exactly one Owner:
    //   SELECT s.id, s.subdomain, count(m.id) AS owners FROM stores s
    //   LEFT JOIN memberships m ON m.store_id = s.id AND m.role = 'owner'
    //   GROUP BY s.id HAVING count(m.id) <> 1;
    //
    // Rollout: every Store creation must insert the Store and its Owner's
    // Membership in one transaction. Code that commits them separately (a
    // provisionStore on a platformClient without BEGIN, as before this
    // check existed, or an ad-hoc script in autocommit) has every Store
    // creation refused once this trigger exists. So the transactional
    // platformClient ships before this trigger is installed, or with it;
    // rolling the code back to a non-transactional platformClient needs
    // DROP TRIGGER stores_exactly_one_owner_at_creation ON stores first.
    //
    // Hardened like part 3: memberships is named through the trigger's own
    // schema (it sits beside stores), search_path is pinned, and
    // row_security = off makes a Store that RLS would hide an error rather
    // than a skipped check. A transaction that inserts a Store cannot then
    // ALTER or TRUNCATE stores: Postgres refuses both while the Store's
    // check is pending.
    await client.query(`
      CREATE OR REPLACE FUNCTION stores_check_exactly_one_owner_at_creation()
      RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      SET row_security = off
      AS $func$
      DECLARE
        store_exists boolean;
        owners integer;
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.id IS NOT DISTINCT FROM OLD.id THEN
          RETURN NULL;
        END IF;
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE id = $1)', TG_TABLE_SCHEMA, TG_TABLE_NAME)
          INTO store_exists USING NEW.id;
        IF NOT store_exists THEN
          RETURN NULL;
        END IF;
        EXECUTE format('SELECT count(*) FROM %I.memberships WHERE store_id = $1 AND role = %L',
                       TG_TABLE_SCHEMA, 'owner')
          INTO owners USING NEW.id;
        IF owners <> 1 THEN
          RAISE EXCEPTION 'Store % must have exactly one Owner when it is created; this transaction creates it with %.',
            NEW.id, owners
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = TG_NAME,
                  SCHEMA = TG_TABLE_SCHEMA,
                  TABLE = TG_TABLE_NAME,
                  DETAIL = CASE TG_OP
                    WHEN 'UPDATE' THEN format('This transaction changed its id from %s.', OLD.id)
                    ELSE 'This transaction inserted it.'
                  END,
                  HINT = 'Insert the Store and its Owner''s Membership in one transaction, '
                    || 'as provisionStore does.';
        END IF;
        RETURN NULL;
      END;
      $func$;
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS stores_exactly_one_owner_at_creation ON stores;
      CREATE CONSTRAINT TRIGGER stores_exactly_one_owner_at_creation
        AFTER INSERT OR UPDATE OF id ON stores
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION stores_check_exactly_one_owner_at_creation();
    `);

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
    // Pay's bookkeeping (ADR-0006): the Order's current Stripe Checkout
    // attempt (0 before the first), when it started, and its Checkout Session
    // once Stripe has returned one.
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_attempt integer NOT NULL DEFAULT 0;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_started_at timestamptz;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_session_id text;`);

    // ── payments (TENANT table — RLS-protected; ADR-0006) ──
    // One row per Stripe PaymentIntent the webhook accepted for an Order of
    // the Store: the Payment that paid it (paid), or one refunded
    // automatically (refund_due until Stripe has refunded it, then refunded;
    // refund_failed with Stripe's error code when Stripe refused the refund,
    // for a person to refund by hand). order_id is NULL when the Order the
    // payment named was not in the Store.
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
        stripe_account_id text NOT NULL,
        payment_intent_id text NOT NULL,
        checkout_session_id text NOT NULL,
        amount_cents bigint NOT NULL,
        currency text NOT NULL,
        status text NOT NULL,
        refund_reason text,
        refund_attempts integer NOT NULL DEFAULT 0,
        stripe_refund_id text,
        stripe_refund_status text,
        refund_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payments_payment_intent_key UNIQUE (payment_intent_id),
        CONSTRAINT payments_status_check CHECK (status IN ('paid', 'refund_due', 'refunded', 'refund_failed')),
        CONSTRAINT payments_refund_reason_check CHECK (
          (status = 'paid' AND refund_reason IS NULL)
          OR (status <> 'paid' AND refund_reason IS NOT NULL
              AND refund_reason IN ('insufficient_inventory', 'already_paid', 'mismatch', 'order_not_payable'))
        ),
        CONSTRAINT payments_refund_error_check CHECK ((status = 'refund_failed') = (refund_error IS NOT NULL))
      );
    `);
    await client.query(`DROP TRIGGER IF EXISTS payments_set_store_id ON payments; CREATE TRIGGER payments_set_store_id BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`ALTER TABLE payments ENABLE ROW LEVEL SECURITY;`);
    await client.query(`
      DROP POLICY IF EXISTS payments_tenant ON payments;
      CREATE POLICY payments_tenant ON payments
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    await client.query(`GRANT SELECT, INSERT, UPDATE ON payments TO "default";`);

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

    // ── discounts + discount_redemptions (tenant tables, RLS-protected) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS discounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        name text NOT NULL,
        trigger jsonb NOT NULL,
        reward jsonb NOT NULL,
        conditions jsonb,
        usage_count integer NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS discount_redemptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        discount_id uuid NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
        order_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (discount_id, order_id)
      );
    `);
    await client.query(`DROP TRIGGER IF EXISTS discounts_set_store_id ON discounts; CREATE TRIGGER discounts_set_store_id BEFORE INSERT ON discounts FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`DROP TRIGGER IF EXISTS discount_redemptions_set_store_id ON discount_redemptions; CREATE TRIGGER discount_redemptions_set_store_id BEFORE INSERT ON discount_redemptions FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`ALTER TABLE discounts ENABLE ROW LEVEL SECURITY;`);
    await client.query(`ALTER TABLE discount_redemptions ENABLE ROW LEVEL SECURITY;`);
    await client.query(`
      DROP POLICY IF EXISTS discounts_tenant ON discounts;
      CREATE POLICY discounts_tenant ON discounts
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    await client.query(`
      DROP POLICY IF EXISTS discount_redemptions_tenant ON discount_redemptions;
      CREATE POLICY discount_redemptions_tenant ON discount_redemptions
        FOR ALL TO "default"
        USING (current_setting('app.store_id', true) = store_id::text)
        WITH CHECK (current_setting('app.store_id', true) = store_id::text);
    `);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON discounts, discount_redemptions TO "default";`);

    // ── customers + customer_sessions + addresses (tenant tables, RLS-protected) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        email text NOT NULL,
        name text NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (store_id, email)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        token text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS addresses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        full_name text NOT NULL,
        line1 text NOT NULL,
        line2 text,
        city text NOT NULL,
        region text NOT NULL,
        postal_code text NOT NULL,
        country text NOT NULL,
        phone text,
        is_default boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`DROP TRIGGER IF EXISTS customers_set_store_id ON customers; CREATE TRIGGER customers_set_store_id BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`DROP TRIGGER IF EXISTS customer_sessions_set_store_id ON customer_sessions; CREATE TRIGGER customer_sessions_set_store_id BEFORE INSERT ON customer_sessions FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    await client.query(`DROP TRIGGER IF EXISTS addresses_set_store_id ON addresses; CREATE TRIGGER addresses_set_store_id BEFORE INSERT ON addresses FOR EACH ROW EXECUTE FUNCTION stamp_store_id();`);
    for (const tbl of ["customers", "customer_sessions", "addresses"]) {
      await client.query(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;`);
      await client.query(`
        DROP POLICY IF EXISTS ${tbl}_tenant ON ${tbl};
        CREATE POLICY ${tbl}_tenant ON ${tbl}
          FOR ALL TO "default"
          USING (current_setting('app.store_id', true) = store_id::text)
          WITH CHECK (current_setting('app.store_id', true) = store_id::text);
      `);
    }
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON customers, customer_sessions, addresses TO "default";`);

    // ── subscriptions (PLATFORM table — one Store → one Tier, no RLS) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL UNIQUE,
        tier_id text NOT NULL,
        stripe_subscription_id text,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // ── custom_domains (PLATFORM table — host→Store mapping, no RLS) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_domains (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        hostname text NOT NULL UNIQUE,
        verification_status text NOT NULL DEFAULT 'pending',
        is_apex boolean NOT NULL DEFAULT false,
        txt_verification_value text,
        last_verified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // ── No Commission (ADR-0007): the old per-Store rate is dropped ──
    await client.query(`ALTER TABLE stores DROP COLUMN IF EXISTS commission_bps;`);
    // ── status on stores (platform admin: active | suspended | terminated) ──
    await client.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';`);

    // ── stripe_payment_accounts (PLATFORM table — no RLS; ADR-0006) ──
    // A Store's Stripe account: saved once, never replaced (nor deleted, but
    // with its Store), one per Store and one Store per account. Whether it
    // can take card payments is only what the latest read of Stripe reported
    // (card_payments_status, and charges_enabled only while that is
    // 'active'); status_read is the ticket of that read, so an older read
    // never overwrites a newer one.
    await client.query(`
      CREATE TABLE IF NOT EXISTS stripe_payment_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
        connect_account_id text NOT NULL,
        charges_enabled boolean NOT NULL DEFAULT false,
        card_payments_status text,
        status_read bigint,
        status_checked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // A table created before Stripe accounts were saved (PR B's shape).
    await client.query(`
      ALTER TABLE stripe_payment_accounts
        ADD COLUMN IF NOT EXISTS card_payments_status text,
        ADD COLUMN IF NOT EXISTS status_read bigint,
        ADD COLUMN IF NOT EXISTS status_checked_at timestamptz,
        DROP COLUMN IF EXISTS details_submitted;
      CREATE SEQUENCE IF NOT EXISTS stripe_account_reads;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stripe_payment_accounts'::regclass
                         AND conname = 'stripe_payment_accounts_card_payments_status_check') THEN
          ALTER TABLE stripe_payment_accounts ADD CONSTRAINT stripe_payment_accounts_card_payments_status_check
            CHECK (card_payments_status IN ('active', 'pending', 'restricted', 'unsupported'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stripe_payment_accounts'::regclass
                         AND conname = 'stripe_payment_accounts_enabled_only_when_active') THEN
          -- A flag no read of Stripe set cannot stand: off until the next read.
          UPDATE stripe_payment_accounts SET charges_enabled = false, updated_at = now()
            WHERE charges_enabled AND card_payments_status IS DISTINCT FROM 'active';
          ALTER TABLE stripe_payment_accounts ADD CONSTRAINT stripe_payment_accounts_enabled_only_when_active
            CHECK (NOT charges_enabled OR card_payments_status IS NOT DISTINCT FROM 'active');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stripe_payment_accounts'::regclass
                         AND conname = 'stripe_payment_accounts_connect_account_id_key') THEN
          ALTER TABLE stripe_payment_accounts ADD CONSTRAINT stripe_payment_accounts_connect_account_id_key
            UNIQUE (connect_account_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stripe_payment_accounts'::regclass
                         AND conname = 'stripe_payment_accounts_connect_account_id_check') THEN
          ALTER TABLE stripe_payment_accounts ADD CONSTRAINT stripe_payment_accounts_connect_account_id_check
            CHECK (connect_account_id ~ '^acct_[A-Za-z0-9]{1,64}$');
        END IF;
      END $$;
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION stripe_payment_accounts_keep_account() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          -- Only with its Store: the cascade runs once the Store row is gone.
          IF EXISTS (SELECT 1 FROM stores WHERE id = OLD.store_id) THEN
            RAISE EXCEPTION 'a Store''s saved Stripe account is never replaced (ADR-0006)' USING ERRCODE = 'check_violation';
          END IF;
          RETURN OLD;
        END IF;
        IF NEW.connect_account_id IS DISTINCT FROM OLD.connect_account_id OR NEW.store_id IS DISTINCT FROM OLD.store_id THEN
          RAISE EXCEPTION 'a Store''s saved Stripe account is never replaced (ADR-0006)' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS stripe_payment_accounts_keep_account ON stripe_payment_accounts;
      CREATE TRIGGER stripe_payment_accounts_keep_account BEFORE UPDATE OR DELETE ON stripe_payment_accounts
        FOR EACH ROW EXECUTE FUNCTION stripe_payment_accounts_keep_account();
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
 * Both inserts run in the one transaction platformClient opens: if either
 * fails (an unknown ownerId is 23503 memberships_user_id_fkey, a taken
 * subdomain 23505 stores_subdomain_key), neither is kept and the error is
 * rethrown. Until it commits, the new Store row holds its subdomain: a
 * concurrent call for the same subdomain waits for this one, then fails
 * with 23505 if it committed, or goes ahead if it rolled back.
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

// Pure host parsing (parseSubdomain, the platform domain, Custom Domain
// hostname rules) lives in ./hostname so it can be unit tested without a DB.

/**
 * The Merchant's (user's) Role in the given Store, or null when they have
 * none. This is the database half of the dashboard authorization gate; the
 * web layer compares the Role with a capability's minimum Role (./roles).
 *
 * Fails closed, returning null (no capability at all) when:
 * - the user holds no Membership in the Store, or the Store does not exist
 *   (the two are indistinguishable to the caller);
 * - the Store id is not a UUID (checked before any query, so a bad URL
 *   segment is answered like a non-member instead of raising 22P02);
 * - the stored role text is not exactly "owner", "admin" or "staff".
 *
 * The database holds at most one Membership per person per Store, with one
 * of those three role texts (memberships_user_store_key and
 * memberships_role_check, see applySchema()). The read does not rely on it:
 * as defense in depth, for a database those constraints have not reached,
 * it reads every row and effectiveRole (./roles) fails closed. With several
 * rows every row must hold a valid Role and the lowest one is returned, so
 * extra rows can only take authority away; one invalid row means null.
 */
export async function getMembershipRole(
  userId: string,
  storeId: string,
): Promise<Role | null> {
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof storeId !== "string" || !UUID.test(storeId)) return null;
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT role FROM memberships WHERE user_id = ${userId} AND store_id = ${storeId}`,
    );
    return effectiveRole((rows.rows as Array<{ role: unknown }>).map((row) => row.role));
  });
}

/**
 * Whether a Merchant (user) holds a Membership with a valid Role in the
 * given Store. A boolean cannot enforce a Role: dashboard code authorizes
 * through getMembershipRole (apps/web/lib/current-store.ts authorizeStore).
 */
export async function authorizeStoreMembership(
  userId: string,
  storeId: string,
): Promise<boolean> {
  return (await getMembershipRole(userId, storeId)) !== null;
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
 *
 * The Product's Variants are locked in id order first (the LOCK ORDER at
 * markOrderPaid): the cascade would lock them in storage order, and could
 * deadlock with a payment for them.
 */
export async function deleteProduct(
  storeId: string,
  productId: string,
): Promise<void> {
  await tenantClient(storeId, async (tx) => {
    await tx.execute(
      sql`SELECT id FROM variants WHERE product_id = ${productId} ORDER BY id FOR UPDATE`,
    );
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

// The helpers below take the transaction their caller already holds (never a
// Store id to open their own), so one cart operation is one pool connection.

/**
 * The id of the Customer's cart in the transaction's Store, row-locked until
 * the transaction ends, or null if there is none. The lock serializes writes
 * to one Cart (two tabs, a double click), so none is lost.
 */
async function lockCart(tx: Tx, customerId: string): Promise<string | null> {
  const rows = await tx.execute(
    sql`SELECT id FROM carts WHERE customer_id = ${customerId} LIMIT 1 FOR UPDATE`,
  );
  return rows.rows.length > 0 ? (rows.rows[0]!.id as string) : null;
}

/**
 * lockCart, creating the Cart first if there is none.
 *
 * The create is one upsert on the one-cart-per-customer unique index, and
 * Postgres guarantees an ON CONFLICT DO UPDATE either inserts or updates
 * (and so row-locks) even under concurrency: when another write created the
 * Cart first, this waits for it and locks that row; when a checkout deleted
 * that row meanwhile, it inserts a fresh Cart. (DO NOTHING followed by a
 * second lockCart could find neither and fail the add.) The update only
 * touches updated_at.
 */
async function lockOrCreateCart(tx: Tx, storeId: string, customerId: string): Promise<string> {
  const existing = await lockCart(tx, customerId);
  if (existing !== null) return existing;
  // store_id is stamped from the transaction's GUC by the trigger (ADR-0001).
  const upserted = await tx.execute(
    sql`INSERT INTO carts (store_id, customer_id) VALUES (${storeId}, ${customerId})
        ON CONFLICT (store_id, customer_id) DO UPDATE SET updated_at = now() RETURNING id`,
  );
  return upserted.rows[0]!.id as string;
}

/** A cart's lines in the order they were first added (created_at, see the writers below). */
async function readCartLines(tx: Tx, cartId: string): Promise<CartLine[]> {
  const rows = await tx.execute(
    sql`SELECT variant_id, quantity FROM cart_items WHERE cart_id = ${cartId} ORDER BY created_at, id`,
  );
  return (rows.rows as Array<{ variant_id: string; quantity: number }>).map((r) => ({
    variantId: r.variant_id,
    quantity: r.quantity,
  }));
}

/**
 * Replace a cart's items with `lines`, one row per line in order: each row
 * gets its own clock_timestamp() as created_at (now() is the same for a whole
 * transaction), so readCartLines returns them in this order.
 */
async function writeCartLines(tx: Tx, storeId: string, cartId: string, lines: CartLine[]): Promise<void> {
  await tx.delete(schema.cartItems).where(eq(schema.cartItems.cartId, cartId));
  for (const line of lines) {
    await tx.execute(
      sql`INSERT INTO cart_items (store_id, cart_id, variant_id, quantity, created_at)
          VALUES (${storeId}, ${cartId}, ${line.variantId}, ${line.quantity}, clock_timestamp())`,
    );
  }
}

/**
 * Set one Variant's line in a cart to `quantity`, or remove it (null). The
 * line keeps its place (the created_at of its earliest row); a new line goes
 * last. Rows for the Variant are collapsed into one, so a duplicate left by
 * older code does not survive a change to it.
 */
async function writeCartLine(
  tx: Tx,
  storeId: string,
  cartId: string,
  variantId: string,
  quantity: number | null,
): Promise<void> {
  if (quantity === null) {
    await tx.execute(sql`DELETE FROM cart_items WHERE cart_id = ${cartId} AND variant_id = ${variantId}`);
    return;
  }
  await tx.execute(
    sql`WITH gone AS (
          DELETE FROM cart_items WHERE cart_id = ${cartId} AND variant_id = ${variantId} RETURNING created_at
        )
        INSERT INTO cart_items (store_id, cart_id, variant_id, quantity, created_at)
        SELECT ${storeId}, ${cartId}, ${variantId}, ${quantity},
               coalesce((SELECT min(created_at) FROM gone), clock_timestamp())`,
  );
}

/**
 * Whether `variantId` is a Variant of a PUBLISHED Product in the
 * transaction's Store. One query; RLS scopes both tables to the Store, so
 * another Store's Variant is not found, exactly like an unknown id.
 */
async function isAvailableVariant(tx: Tx, variantId: string): Promise<boolean> {
  const rows = await tx.execute(
    sql`SELECT 1 FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = ${variantId} AND p.status = 'published' LIMIT 1`,
  );
  return rows.rows.length > 0;
}

/** Price and published state of the given Variants the transaction's Store can see (RLS). */
async function readCheckoutVariants(tx: Tx, variantIds: string[]): Promise<Map<string, CheckoutVariant>> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: schema.variants.id,
      priceCents: schema.variants.priceCents,
      status: schema.products.status,
    })
    .from(schema.variants)
    .innerJoin(schema.products, eq(schema.products.id, schema.variants.productId))
    .where(inArray(schema.variants.id, ids));
  return new Map(
    rows.map((r) => [r.id, { priceCents: r.priceCents, published: r.status === "published" }]),
  );
}

/**
 * Get or create a Customer's cart for the given Store. Returns the cart id.
 * One cart per customer per store (enforced by a unique index).
 */
export async function getOrCreateDbCart(
  storeId: string,
  customerId: string,
): Promise<string> {
  return tenantClient(storeId, (tx) => lockOrCreateCart(tx, storeId, customerId));
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
    return { storeId, lines: await readCartLines(tx, cartRows.rows[0]!.id as string) };
  });
}

/**
 * Save a cart's lines to the database, replacing any existing items, in one
 * transaction on one connection (creating the cart if needed).
 */
export async function saveDbCartLines(
  storeId: string,
  customerId: string,
  lines: CartLine[],
): Promise<void> {
  await tenantClient(storeId, async (tx) => {
    const cartId = await lockOrCreateCart(tx, storeId, customerId);
    await writeCartLines(tx, storeId, cartId, lines);
  });
}

/**
 * Apply one shopper change to a Customer's Cart, validated, in ONE
 * transaction on one connection. This is how the storefront changes a Cart.
 *
 * - The change is re-parsed (parseCartChange: UUID shape, quantity rule), so
 *   bad input never reaches SQL.
 * - add, and set to a quantity above 0, need the Variant to be one of a
 *   PUBLISHED Product in this Store (one query under RLS); otherwise
 *   "unavailable", whether the id is unknown, a draft or another Store's.
 * - The Cart row is locked, then the pure line math applies the change
 *   (applyCartChange: an add may not take a line above MAX_LINE_QUANTITY), so
 *   concurrent changes to one Cart are serialized and none is lost.
 * - A refused change writes nothing. remove and set never create a Cart.
 */
export async function changeDbCart(
  storeId: string,
  customerId: string,
  change: CartChange,
): Promise<CartChangeResult> {
  const parsed = parseCartChange(change.kind, change.variantId, "quantity" in change ? change.quantity : undefined);
  if (!parsed.ok) return parsed;
  const valid = parsed.change;
  const needsAvailableVariant = valid.kind === "add" || (valid.kind === "set" && valid.quantity > 0);

  return tenantClient(storeId, async (tx): Promise<CartChangeResult> => {
    if (needsAvailableVariant && !(await isAvailableVariant(tx, valid.variantId))) {
      return { ok: false, reason: "unavailable" };
    }
    const cartId =
      valid.kind === "add" ? await lockOrCreateCart(tx, storeId, customerId) : await lockCart(tx, customerId);
    if (cartId === null) return { ok: true, cart: { storeId, lines: [] } };

    const result = applyCartChange({ storeId, lines: await readCartLines(tx, cartId) }, valid);
    if (!result.ok) return result;
    const line = result.cart.lines.find((l) => l.variantId === valid.variantId);
    await writeCartLine(tx, storeId, cartId, valid.variantId, line?.quantity ?? null);
    return result;
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
 * 1. Locks the Cart row: a second checkout of the same Cart waits here, then
 *    finds it consumed ("empty_cart"), so one Cart makes at most one Order.
 * 2. Re-validates every line against the live catalog (priceCartForCheckout):
 *    a Variant of a PUBLISHED Product in this Store (RLS), at a whole quantity
 *    from 1 to MAX_LINE_QUANTITY. Any invalid line refuses the WHOLE checkout
 *    with a CheckoutError and writes nothing; no line is dropped silently.
 * 3. Creates an Order in payment=pending, fulfillment=unfulfilled, with Order
 *    Lines at snapshotted unit prices (frozen at checkout).
 * 4. Consumes the Cart (deletes it).
 *
 * Inventory is NOT decremented here — that happens in the payment transaction.
 */
export async function checkout(
  storeId: string,
  customerId: string,
): Promise<{ orderId: string; totalCents: number }> {
  return tenantClient(storeId, async (tx) => {
    const cartId = await lockCart(tx, customerId);
    if (cartId === null) throw new CheckoutError("empty_cart");
    const lines = await readCartLines(tx, cartId);

    const priced = priceCartForCheckout(
      lines,
      await readCheckoutVariants(tx, lines.map((l) => l.variantId)),
    );
    if (!priced.ok) {
      throw new CheckoutError(priced.reason, priced.reason === "invalid_lines" ? priced.problems : []);
    }

    const [order] = await tx
      .insert(schema.orders)
      .values({
        storeId,
        customerId,
        paymentStatus: "pending",
        fulfillmentStatus: "unfulfilled",
        totalCents: priced.totalCents,
      })
      .returning();

    for (const line of priced.lines) {
      await tx.insert(schema.orderLines).values({
        storeId,
        orderId: order!.id,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        // Its own timestamp (now() is the transaction's), so the lines read
        // back in Cart order (getStorefrontOrder orders by created_at).
        createdAt: sql`clock_timestamp()`,
      });
    }

    await tx.delete(schema.carts).where(eq(schema.carts.id, cartId));

    return { orderId: order!.id, totalCents: priced.totalCents };
  });
}

/**
 * Load an Order by id (with its lines), scoped to the Current Store via RLS.
 * Returns null if the Order doesn't exist, belongs to another Store, or the
 * id is not a UUID.
 *
 * Store-scoped only: it returns ANY Order of the Store to whoever asks. It is
 * for Merchant and payment code that has already authorized the Store. The
 * storefront must use getStorefrontOrder, which also requires the cart token
 * that placed the Order.
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
  if (!isUuid(orderId)) return null;
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

/** An Order as the shopper who placed it sees it on the storefront. */
export type StorefrontOrder = {
  id: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  totalCents: number;
  /** Titles, not Variant ids; null when the Variant has since been deleted. */
  lines: Array<{
    productTitle: string | null;
    variantTitle: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
  /**
   * The Payment Stripe reported for the Order's current Checkout Session, if
   * any: the one that paid it, or one refunded automatically, with the
   * reason (ADR-0006). A Payment of an earlier session is not shown.
   */
  payment: { status: PaymentRecordStatus; refundReason: RefundReason | null } | null;
};

/**
 * Load an Order for the storefront, only for the cart token that placed it.
 *
 * Until checkout has Customer sign-in or a signed Order-access token, an
 * Order's customer_id is the anonymous cart token (the httpOnly
 * shp0_cart_token cookie) of the Cart it came from, and that token is the
 * shopper's proof. The id and the token are matched in ONE query (under RLS,
 * so the Order must also be in `storeId`): no token, another shopper's token,
 * a malformed id or token, another Store's Order and a nonexistent Order all
 * return null, indistinguishably. The Order id alone (it is in URLs, history
 * and referrers) is not enough.
 */
export async function getStorefrontOrder(
  storeId: string,
  orderId: string,
  cartToken: string | null | undefined,
): Promise<StorefrontOrder | null> {
  if (!isUuid(orderId) || !isUuid(cartToken)) return null;
  return tenantClient(storeId, async (tx) => {
    const orderRows = await tx.execute(
      sql`SELECT id, payment_status, fulfillment_status, total_cents, checkout_session_id FROM orders
          WHERE id = ${orderId} AND customer_id = ${cartToken} LIMIT 1`,
    );
    if (orderRows.rows.length === 0) return null;
    const o = orderRows.rows[0] as {
      id: string;
      payment_status: string;
      fulfillment_status: string;
      total_cents: string | number;
      checkout_session_id: string | null;
    };

    const lineRows = await tx.execute(
      sql`SELECT p.title AS product_title, v.title AS variant_title, ol.quantity, ol.unit_price_cents
          FROM order_lines ol
          LEFT JOIN variants v ON v.id = ol.variant_id
          LEFT JOIN products p ON p.id = v.product_id
          WHERE ol.order_id = ${o.id}
          ORDER BY ol.created_at, ol.id`,
    );
    const paymentRows =
      o.checkout_session_id === null
        ? []
        : (
            await tx.execute(
              sql`SELECT status, refund_reason FROM payments
                  WHERE order_id = ${o.id} AND checkout_session_id = ${o.checkout_session_id}
                  ORDER BY created_at DESC LIMIT 1`,
            )
          ).rows;
    const payment = paymentRows[0] as { status: PaymentRecordStatus; refund_reason: RefundReason | null } | undefined;
    return {
      id: o.id,
      paymentStatus: o.payment_status,
      fulfillmentStatus: o.fulfillment_status,
      // bigint columns arrive as strings from raw queries.
      totalCents: Number(o.total_cents),
      lines: (
        lineRows.rows as Array<{
          product_title: string | null;
          variant_title: string | null;
          quantity: number;
          unit_price_cents: string | number;
        }>
      ).map((r) => ({
        productTitle: r.product_title,
        variantTitle: r.variant_title,
        quantity: r.quantity,
        unitPriceCents: Number(r.unit_price_cents),
      })),
      payment: payment ? { status: payment.status, refundReason: payment.refund_reason } : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Payment transaction + idempotency (Issue #10, ADR-0002).
//
// markOrderPaid() is the concurrency fence: it transitions payment: pending→paid,
// reads the affected Variants FOR NO KEY UPDATE (row-lock), checks + decrements
// inventory, all atomically inside ONE transaction. No oversell is possible.
//
// LOCK ORDER: a transaction that locks more than one Variant locks them in id
// order (markOrderPaid, deleteProduct). Two such transactions can make each
// other wait, but never deadlock.
// ─────────────────────────────────────────────────────────────────────────

/** How many times a payment transaction runs when it loses a deadlock. */
const PAYMENT_ATTEMPTS = 3;

/**
 * Runs a payment transaction again when Postgres aborts it to break a
 * deadlock with some other transaction (40P01). Nothing was committed, so a
 * new attempt starts from scratch; at most PAYMENT_ATTEMPTS in all.
 */
async function withDeadlockRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt < PAYMENT_ATTEMPTS && (error as { code?: unknown } | null)?.code === "40P01") continue;
      throw error;
    }
  }
}

/**
 * Transition an Order to paid and decrement inventory atomically.
 *
 * THE CONCURRENCY FENCE (ADR-0002):
 * 1. Lock the Order row and check it is pending (idempotency).
 * 2-5. takeStock: read the lines per Variant in id order, lock the Variants
 *    in id order, check and decrement their inventory.
 * 6. Transition payment: pending → paid.
 *
 * All in ONE transaction — if the stock check fails, nothing is committed (no
 * partial decrement). If Postgres aborts the transaction to break a deadlock
 * with some other transaction (40P01), nothing was committed, and the whole
 * transaction runs again, up to PAYMENT_ATTEMPTS times.
 *
 * Returns ok if the transition succeeded, already_paid if the order was
 * already paid (idempotent — safe to call from a replayed webhook). Throws
 * for an Order that is not found, not pending, or has a Variant that no
 * longer exists. The Stripe webhook uses recordStripePayment instead.
 */
export async function markOrderPaid(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; reason: "already_paid" | "insufficient_inventory" }> {
  return withDeadlockRetry(() =>
    tenantClient(storeId, async (tx) => {
      // Check current payment status (idempotency).
      const orderRows = await tx.execute(
        sql`SELECT payment_status FROM orders WHERE id = ${orderId} FOR UPDATE`,
      );
      if (orderRows.rows.length === 0) {
        throw new Error(`Order ${orderId} not found`);
      }
      const currentStatus = orderRows.rows[0]!.payment_status as string;
      if (currentStatus === "paid") {
        return { ok: false, reason: "already_paid" } as const;
      }
      if (currentStatus !== "pending") {
        throw new Error(`Order ${orderId} is in unexpected state: ${currentStatus}`);
      }

      const stock = await takeStock(tx, orderId);
      if (stock.ok === false) {
        if ("missingVariantId" in stock) throw new Error(`Variant ${stock.missingVariantId} not found`);
        return { ok: false, reason: "insufficient_inventory" } as const;
      }

      // Transition payment: pending → paid.
      await tx.execute(
        sql`UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = ${orderId}`,
      );
      return { ok: true } as const;
    }),
  );
}

/**
 * Check and decrement the stock for one pending Order whose row the caller
 * has locked, inside the caller's transaction (steps 2-5 of the fence):
 *
 * 2. Read the Order's lines, one row per Variant with the total quantity of
 *    its lines, in Variant id order.
 * 3. Lock all those Variants in one statement, in id order (the LOCK ORDER
 *    above; line order is the order the Cart was filled in, and two Orders
 *    locking in opposite orders would deadlock).
 * 4. Check inventory >= total for every Variant. If any Variant is gone or
 *    short, stop: nothing has been written.
 * 5. Decrement all Variants.
 */
async function takeStock(
  tx: Tx,
  orderId: string,
): Promise<{ ok: true } | { ok: false; missingVariantId: string } | { ok: false; insufficient: true }> {
  const lineRows = await tx.execute(
    sql`SELECT variant_id, sum(quantity)::int AS quantity FROM order_lines WHERE order_id = ${orderId} GROUP BY variant_id ORDER BY variant_id`,
  );
  const lines = lineRows.rows as Array<{ variant_id: string; quantity: number }>;

  // Lock every Variant in id order (rows are locked as they leave the sort),
  // then check each one. The lock serializes concurrent payments; NO KEY
  // UPDATE is the lock the decrement takes anyway.
  const variantRows = await tx.execute(
    sql`SELECT id, inventory FROM variants WHERE id = ANY(${sql.param(lines.map((line) => line.variant_id))}::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
  );
  const inventories = new Map(
    (variantRows.rows as Array<{ id: string; inventory: number }>).map((row) => [row.id, row.inventory]),
  );
  for (const line of lines) {
    const inventory = inventories.get(line.variant_id);
    if (inventory === undefined) return { ok: false, missingVariantId: line.variant_id };
    // Insufficient inventory — NO decrement happens (none has been written).
    if (inventory < line.quantity) return { ok: false, insufficient: true };
  }

  // All checks passed — decrement every variant.
  for (const line of lines) {
    await tx.execute(
      sql`UPDATE variants SET inventory = inventory - ${line.quantity} WHERE id = ${line.variant_id}`,
    );
  }
  return { ok: true };
}

/** The Currency every Store charges in until a Store's Currency is stored (ADR-0004). */
export const STORE_CURRENCY = "usd";

/** Why a Payment is refunded automatically (ADR-0006). */
export type RefundReason = "insufficient_inventory" | "already_paid" | "mismatch" | "order_not_payable";

/** A Payment's outcome (the payments table's status). */
export type PaymentRecordStatus = "paid" | "refund_due" | "refunded" | "refund_failed";

/**
 * Record a Stripe payment the webhook accepted for an Order of the Store, and
 * pay the Order with it when it can (ADR-0006, the payment transaction of
 * ADR-0002). One transaction, retried on a deadlock like markOrderPaid:
 *
 * 1. Claim the PaymentIntent: insert its Payment row, or find the row a
 *    previous delivery wrote (a concurrent delivery of the same payment waits
 *    on the unique key, then finds it). A PaymentIntent that already has a
 *    Payment is never applied or refunded a second time: `paid`, `refunded`
 *    and `refund_failed` need nothing, and a Payment still `refund_due` is
 *    tried again, as a new attempt (refund_attempts).
 * 2. Lock the Order row (in this Store, under RLS). The Payment is refunded
 *    when the Order is not there or not pending (order_not_payable), already
 *    paid (already_paid: by another PaymentIntent, since this one is new), or
 *    when the amount or currency is not the Order's (mismatch).
 * 3. Take the stock (takeStock). A Variant gone or short refunds the Payment
 *    (insufficient_inventory) and leaves the Order pending (ADR-0002 point 4).
 * 4. Otherwise the Order becomes paid, and the Payment `paid`.
 *
 * A Payment to refund is recorded `refund_due`, with its reason, in the same
 * transaction, before any refund is requested. Returns what the caller must
 * do next: nothing, or refund the PaymentIntent in full (this attempt's
 * number, for the request's idempotency key) and then call
 * markPaymentRefunded (or markPaymentRefundFailed if Stripe refuses).
 */
export async function recordStripePayment(
  storeId: string,
  payment: {
    orderId: string;
    stripeAccountId: string;
    paymentIntentId: string;
    checkoutSessionId: string;
    amountCents: number;
    currency: string;
  },
): Promise<{ action: "none" } | { action: "refund"; reason: RefundReason; attempt: number }> {
  if (!isUuid(storeId) || !isUuid(payment.orderId)) {
    throw new Error("recordStripePayment needs a Store id and an Order id");
  }
  return withDeadlockRetry(() =>
    tenantClient(storeId, async (tx) => {
      // 1. Claim the PaymentIntent.
      const claimed = await tx.execute(
        sql`INSERT INTO payments (stripe_account_id, payment_intent_id, checkout_session_id, amount_cents, currency, status, refund_reason)
            VALUES (${payment.stripeAccountId}, ${payment.paymentIntentId}, ${payment.checkoutSessionId},
                    ${payment.amountCents}, ${payment.currency}, 'refund_due', 'order_not_payable')
            ON CONFLICT (payment_intent_id) DO NOTHING
            RETURNING id`,
      );
      if (claimed.rows.length === 0) {
        const existing = await tx.execute(
          sql`UPDATE payments SET refund_attempts = refund_attempts + 1, updated_at = now()
              WHERE payment_intent_id = ${payment.paymentIntentId} AND status = 'refund_due'
              RETURNING refund_reason, refund_attempts`,
        );
        // Nothing to do unless the Payment is still due a refund: `paid`,
        // `refunded` and `refund_failed` are final here. (A row of another
        // Store is not visible under RLS; its PaymentIntent is not this
        // Store's to act on.)
        const row = existing.rows[0] as { refund_reason: RefundReason; refund_attempts: number } | undefined;
        if (!row) return { action: "none" } as const;
        return { action: "refund", reason: row.refund_reason, attempt: row.refund_attempts } as const;
      }

      const refund = async (reason: RefundReason, orderId: string | null) => {
        await tx.execute(
          sql`UPDATE payments SET refund_reason = ${reason}, order_id = ${orderId}, refund_attempts = 1, updated_at = now()
              WHERE payment_intent_id = ${payment.paymentIntentId}`,
        );
        return { action: "refund", reason, attempt: 1 } as const;
      };

      // 2. Lock the Order and check it can take this payment.
      const orderRows = await tx.execute(
        sql`SELECT payment_status, total_cents::bigint AS total_cents FROM orders WHERE id = ${payment.orderId} FOR UPDATE`,
      );
      const order = orderRows.rows[0] as { payment_status: string; total_cents: string | number } | undefined;
      if (!order) return refund("order_not_payable", null);
      if (order.payment_status === "paid") return refund("already_paid", payment.orderId);
      if (order.payment_status !== "pending") return refund("order_not_payable", payment.orderId);
      if (Number(order.total_cents) !== payment.amountCents || payment.currency !== STORE_CURRENCY) {
        return refund("mismatch", payment.orderId);
      }

      // 3. Take the stock.
      const stock = await takeStock(tx, payment.orderId);
      if (!stock.ok) return refund("insufficient_inventory", payment.orderId);

      // 4. Pay the Order with this Payment.
      await tx.execute(
        sql`UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = ${payment.orderId}`,
      );
      await tx.execute(
        sql`UPDATE payments SET status = 'paid', refund_reason = NULL, order_id = ${payment.orderId}, updated_at = now()
            WHERE payment_intent_id = ${payment.paymentIntentId}`,
      );
      return { action: "none" } as const;
    }),
  );
}

/**
 * Record that Stripe created the refund of a Payment due one, with the
 * Refund's id and status (`succeeded`, or `pending` until the money is back).
 * Both are null when Stripe answered that the charge was already refunded.
 */
export async function markPaymentRefunded(
  storeId: string,
  paymentIntentId: string,
  refund: { id: string; status: string | null } | null,
): Promise<void> {
  await tenantClient(storeId, async (tx) => {
    await tx.execute(
      sql`UPDATE payments SET status = 'refunded', stripe_refund_id = ${refund?.id ?? null},
            stripe_refund_status = ${refund?.status ?? null}, updated_at = now()
          WHERE payment_intent_id = ${paymentIntentId} AND status = 'refund_due'`,
    );
  });
}

/**
 * Record that Stripe refused, for good, to refund a Payment due a refund (for
 * example a disputed charge, or no access to the account), with Stripe's
 * error code. A Store Admin or an Operator must refund it by hand (ADR-0006).
 */
export async function markPaymentRefundFailed(
  storeId: string,
  paymentIntentId: string,
  errorCode: string,
): Promise<void> {
  await tenantClient(storeId, async (tx) => {
    await tx.execute(
      sql`UPDATE payments SET status = 'refund_failed', refund_error = ${errorCode}, updated_at = now()
          WHERE payment_intent_id = ${paymentIntentId} AND status = 'refund_due'`,
    );
  });
}

/** The outcome of the Payment recorded for a PaymentIntent, or null if none is. */
export async function getPaymentStatus(
  storeId: string,
  paymentIntentId: string,
): Promise<PaymentRecordStatus | null> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT status FROM payments WHERE payment_intent_id = ${paymentIntentId} LIMIT 1`,
    );
    return (rows.rows[0]?.status as PaymentRecordStatus | undefined) ?? null;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Pay: one Stripe Checkout Session per Order at a time (ADR-0006).
//
// An Order records its current Checkout attempt: a number, when it started
// and, once Stripe returned it, its session. A new attempt is started only
// through reserveCheckoutAttempt (one of two concurrent Pays wins), and a
// session reaches the Customer only once recordCheckoutSession has recorded
// it. So an Order never has two sessions a Customer could pay. The caller
// (@shp0/payments startCheckout) has already matched the Order to the
// Customer's cart token with getOrderForCheckout.
// ─────────────────────────────────────────────────────────────────────────

/**
 * How long an attempt without a session counts as still being created: a Pay
 * in that time re-sends the attempt's key rather than start another. After
 * it (or once a failed attempt is ended), the next Pay starts a new attempt.
 * Pay's Stripe requests normally end well within it. Correctness does not
 * depend on that: a session that comes back after its attempt was superseded
 * is never recorded, so never delivered.
 */
export const CHECKOUT_ATTEMPT_LEASE_SECONDS = 60;

/**
 * Start the next Checkout attempt of a pending Order: only if its attempt and
 * session are still `expected`, so of two Pays that saw the same state, one
 * starts it. The session is cleared and the start time stamped. Returns the
 * new attempt number, or null when the Order has changed (or is no longer
 * pending) and the caller must look again.
 */
export async function reserveCheckoutAttempt(
  storeId: string,
  orderId: string,
  expected: { attempt: number; sessionId: string | null },
): Promise<number | null> {
  if (!isUuid(orderId)) return null;
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`UPDATE orders SET checkout_attempt = checkout_attempt + 1, checkout_started_at = now(), checkout_session_id = NULL
          WHERE id = ${orderId} AND payment_status = 'pending'
            AND checkout_attempt = ${expected.attempt}
            AND checkout_session_id IS NOT DISTINCT FROM ${expected.sessionId}
          RETURNING checkout_attempt`,
    );
    return (rows.rows[0]?.checkout_attempt as number | undefined) ?? null;
  });
}

/**
 * End a Checkout attempt whose create failed and has no session: the next Pay
 * starts a new attempt, with a new idempotency key, instead of re-sending
 * this one's (Stripe keeps a key's error). Nothing was delivered for it.
 */
export async function endCheckoutAttempt(storeId: string, orderId: string, attempt: number): Promise<void> {
  if (!isUuid(orderId)) return;
  await tenantClient(storeId, async (tx) => {
    await tx.execute(
      sql`UPDATE orders SET checkout_started_at = NULL
          WHERE id = ${orderId} AND checkout_attempt = ${attempt} AND checkout_session_id IS NULL`,
    );
  });
}

/**
 * Record the Checkout Session Stripe returned for an attempt: only while the
 * Order is pending and the attempt is still its current one, without another
 * session. Returns whether the session is recorded; one that is not must not
 * be given to the Customer.
 */
export async function recordCheckoutSession(
  storeId: string,
  orderId: string,
  attempt: number,
  sessionId: string,
): Promise<boolean> {
  if (!isUuid(orderId)) return false;
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`UPDATE orders SET checkout_session_id = ${sessionId}
          WHERE id = ${orderId} AND payment_status = 'pending' AND checkout_attempt = ${attempt}
            AND (checkout_session_id IS NULL OR checkout_session_id = ${sessionId})
          RETURNING id`,
    );
    return rows.rows.length > 0;
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

// ─────────────────────────────────────────────────────────────────────────
// A Store's Stripe account (ADR-0006 point 2).
//
// Written only through @shp0/payments: connectStripeAccount saves the id
// Stripe returned (savePaymentAccount, never replacing one already saved),
// and every read of the account from Stripe records what Stripe reported
// (startStripeAccountRead, then recordStripeAccountStatus). Pay reads
// chargesEnabled (getPaymentAccount).
// ─────────────────────────────────────────────────────────────────────────

/** A Stripe account id as Stripe mints them (the table's CHECK too). */
const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,64}$/;

/** Stripe's card payments status for an Accounts v2 account (ADR-0006). */
export type CardPaymentsStatus = "active" | "pending" | "restricted" | "unsupported";

/** A Store's Stripe account, as the latest read of Stripe reported it. */
export type PaymentAccount = {
  connectAccountId: string;
  /** Stripe reported the account able to accept card payments (card payments `active`). */
  chargesEnabled: boolean;
  /** Stripe's card payments status at that read; null before any read, or for an account Stripe no longer has. */
  cardPaymentsStatus: CardPaymentsStatus | null;
  /** When that read was recorded. */
  statusCheckedAt: Date | null;
};

/** A Store's Stripe account, or null if it has none. */
export async function getPaymentAccount(storeId: string): Promise<PaymentAccount | null> {
  if (!isUuid(storeId)) return null;
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT connect_account_id, charges_enabled, card_payments_status, status_checked_at
          FROM stripe_payment_accounts WHERE store_id = ${storeId}`,
    );
    const r = rows.rows[0] as
      | {
          connect_account_id: string;
          charges_enabled: boolean;
          card_payments_status: CardPaymentsStatus | null;
          status_checked_at: Date | string | null;
        }
      | undefined;
    if (!r) return null;
    return {
      connectAccountId: r.connect_account_id,
      chargesEnabled: r.charges_enabled,
      cardPaymentsStatus: r.card_payments_status,
      statusCheckedAt: r.status_checked_at === null ? null : new Date(r.status_checked_at),
    };
  });
}

/**
 * Save the Stripe account Stripe created for a Store, unless the Store
 * already has one: a saved account is never replaced. Returns the Store's
 * account (the one saved before, when there was one) and whether this call
 * saved it. Two concurrent saves for a Store keep one. An account another
 * Store has is refused (the unique account id), and nothing is saved.
 */
export async function savePaymentAccount(
  storeId: string,
  accountId: string,
): Promise<{ accountId: string; saved: boolean }> {
  if (!isUuid(storeId)) throw new Error("savePaymentAccount needs a Store id");
  if (!STRIPE_ACCOUNT_ID.test(accountId)) throw new Error("savePaymentAccount needs a Stripe account id (acct_…)");
  return platformClient(async (tx) => {
    const inserted = await tx.execute(
      sql`INSERT INTO stripe_payment_accounts (store_id, connect_account_id) VALUES (${storeId}, ${accountId})
          ON CONFLICT (store_id) DO NOTHING RETURNING connect_account_id`,
    );
    if (inserted.rows.length > 0) return { accountId, saved: true };
    // Another save got there first: a concurrent one has committed by now.
    const existing = await tx.execute(
      sql`SELECT connect_account_id FROM stripe_payment_accounts WHERE store_id = ${storeId}`,
    );
    return { accountId: existing.rows[0]!.connect_account_id as string, saved: false };
  });
}

/** A read of a Store's Stripe account, begun: `read` is its ticket. */
export type StripeAccountRead = { storeId: string; accountId: string; read: string };

/**
 * Begin a read of a Store's saved Stripe account (by the Store, or by the
 * account an event names): the saved account, and a ticket from a sequence,
 * taken before Stripe is asked. Null when there is no such account.
 */
export async function startStripeAccountRead(
  of: { storeId: string } | { accountId: string },
): Promise<StripeAccountRead | null> {
  if ("storeId" in of ? !isUuid(of.storeId) : !STRIPE_ACCOUNT_ID.test(of.accountId)) return null;
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      "storeId" in of
        ? sql`SELECT store_id, connect_account_id, nextval('stripe_account_reads')::text AS read
              FROM stripe_payment_accounts WHERE store_id = ${of.storeId}`
        : sql`SELECT store_id, connect_account_id, nextval('stripe_account_reads')::text AS read
              FROM stripe_payment_accounts WHERE connect_account_id = ${of.accountId}`,
    );
    const r = rows.rows[0] as { store_id: string; connect_account_id: string; read: string } | undefined;
    return r ? { storeId: r.store_id, accountId: r.connect_account_id, read: r.read } : null;
  });
}

/**
 * Record what a read of Stripe reported about a Store's account: only if no
 * read with a later ticket has been recorded ("stale" otherwise), and only
 * for the account the read was begun for. It never touches the account id.
 */
export async function recordStripeAccountStatus(
  read: StripeAccountRead,
  status: { cardPayments: CardPaymentsStatus | null; canTakePayments: boolean },
): Promise<"recorded" | "stale"> {
  if (!isUuid(read.storeId) || !STRIPE_ACCOUNT_ID.test(read.accountId) || !/^\d{1,19}$/.test(read.read)) {
    throw new Error("recordStripeAccountStatus needs a read begun by startStripeAccountRead");
  }
  if (status.canTakePayments && status.cardPayments !== "active") {
    throw new Error("A Stripe account takes card payments only while Stripe reports them active");
  }
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`UPDATE stripe_payment_accounts
          SET charges_enabled = ${status.canTakePayments}, card_payments_status = ${status.cardPayments},
              status_read = ${read.read}::bigint, status_checked_at = now(), updated_at = now()
          WHERE store_id = ${read.storeId} AND connect_account_id = ${read.accountId}
            AND (status_read IS NULL OR status_read < ${read.read}::bigint)
          RETURNING 1`,
    );
    return rows.rows.length > 0 ? "recorded" : "stale";
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

/** An Order as Pay needs it (ADR-0006). */
export type OrderForCheckout = {
  id: string;
  paymentStatus: string;
  totalCents: number;
  /** Every line, in the order placed, a deleted Variant's too. */
  lines: Array<{
    variantId: string;
    /** Null when the Variant has since been deleted. */
    productTitle: string | null;
    variantTitle: string | null;
    quantity: number;
    unitPriceCents: number;
    /** The Variant's units in stock now; null when it has been deleted. */
    inventory: number | null;
  }>;
  /** Pay's bookkeeping. */
  checkout: {
    /** The current attempt; 0 before the first. */
    attempt: number;
    /** The current attempt's Checkout Session, once recorded. */
    sessionId: string | null;
    /**
     * The current attempt has no session yet and started less than
     * CHECKOUT_ATTEMPT_LEASE_SECONDS ago: it may still be being created.
     */
    inFlight: boolean;
  };
};

/**
 * Load an Order for Pay, only for the cart token that placed it, matched in
 * the query like getStorefrontOrder: anyone else gets null, as for a
 * nonexistent Order.
 *
 * A deleted Variant's line is kept (null titles and inventory), so the caller
 * can refuse it and can check that the lines add up to the total.
 */
export async function getOrderForCheckout(
  storeId: string,
  orderId: string,
  cartToken: string | null | undefined,
): Promise<OrderForCheckout | null> {
  if (!isUuid(orderId) || !isUuid(cartToken)) return null;
  return tenantClient(storeId, async (tx) => {
    const orderRows = await tx.execute(
      sql`SELECT id, payment_status, total_cents, checkout_attempt, checkout_session_id,
                 COALESCE(checkout_session_id IS NULL
                   AND checkout_started_at > now() - make_interval(secs => ${CHECKOUT_ATTEMPT_LEASE_SECONDS}), false) AS in_flight
          FROM orders
          WHERE id = ${orderId} AND customer_id = ${cartToken} LIMIT 1`,
    );
    if (orderRows.rows.length === 0) return null;
    const o = orderRows.rows[0] as {
      id: string;
      payment_status: string;
      total_cents: string | number;
      checkout_attempt: number;
      checkout_session_id: string | null;
      in_flight: boolean;
    };

    const lineRows = await tx.execute(
      sql`SELECT ol.variant_id, ol.quantity, ol.unit_price_cents,
                 p.title AS product_title, v.title AS variant_title, v.inventory
          FROM order_lines ol
          LEFT JOIN variants v ON v.id = ol.variant_id
          LEFT JOIN products p ON p.id = v.product_id
          WHERE ol.order_id = ${o.id}
          ORDER BY ol.created_at, ol.id`,
    );
    const lines = (
      lineRows.rows as Array<{
        variant_id: string;
        quantity: number;
        unit_price_cents: string | number;
        product_title: string | null;
        variant_title: string | null;
        inventory: number | null;
      }>
    ).map((r) => ({
      variantId: r.variant_id,
      productTitle: r.product_title,
      variantTitle: r.product_title === null ? null : r.variant_title,
      quantity: r.quantity,
      // bigint columns arrive as strings from raw queries.
      unitPriceCents: Number(r.unit_price_cents),
      inventory: r.product_title === null ? null : r.inventory,
    }));

    return {
      id: o.id,
      paymentStatus: o.payment_status,
      totalCents: Number(o.total_cents),
      lines,
      checkout: { attempt: o.checkout_attempt, sessionId: o.checkout_session_id, inFlight: o.in_flight },
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
 *
 * Both ids must belong to this Store. Foreign-key checks bypass RLS, so a
 * plain INSERT would accept another Store's collection or product id (and a
 * foreign-key error would reveal whether an id exists anywhere). Selecting the
 * pair through RLS links only ids this Store can see; any other id links
 * nothing, silently, whether or not it exists elsewhere.
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
        sql`INSERT INTO collection_products (collection_id, product_id)
            SELECT c.id, p.id FROM collections c, products p
            WHERE c.id = ${collectionId} AND p.id = ${productId}
            ON CONFLICT DO NOTHING`,
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

/**
 * Storefront: list a collection's members by slug (published products only).
 * Used by the storefront collection page. Returns products with their min price.
 */
export async function getStorefrontCollectionBySlug(
  storeId: string,
  slug: string,
): Promise<Array<{ id: string; title: string; slug: string; priceCents: number }>> {
  return tenantClient(storeId, async (tx) => {
    // Find the collection by slug.
    const colRows = await tx.execute(
      sql`SELECT id, type, rule FROM collections WHERE slug = ${slug} LIMIT 1`,
    );
    if (colRows.rows.length === 0) return [];
    const col = colRows.rows[0] as { id: string; type: string; rule: unknown };

    if (col.type === "manual") {
      const rows = await tx.execute(
        sql`
          SELECT p.id, p.title, p.slug,
            (SELECT MIN(v.price_cents) FROM variants v WHERE v.product_id = p.id) as price_cents
          FROM products p
          JOIN collection_products cp ON cp.product_id = p.id
          WHERE cp.collection_id = ${col.id} AND p.status = 'published'
          ORDER BY cp.position, p.title
        `,
      );
      return (rows.rows as Array<{ id: string; title: string; slug: string; price_cents: number }>)
        .map((r) => ({ id: r.id, title: r.title, slug: r.slug, priceCents: r.price_cents }));
    }

    // Automated — evaluate rule, published only.
    const rule = col.rule as CollectionRule | null;
    if (!rule) return [];

    if (rule.type === "tag") {
      const rows = await tx.execute(
        sql`
          SELECT p.id, p.title, p.slug,
            (SELECT MIN(v.price_cents) FROM variants v WHERE v.product_id = p.id) as price_cents
          FROM products p
          WHERE ${rule.tag} = ANY(p.tags) AND p.status = 'published'
          ORDER BY p.title
        `,
      );
      return (rows.rows as Array<{ id: string; title: string; slug: string; price_cents: number }>)
        .map((r) => ({ id: r.id, title: r.title, slug: r.slug, priceCents: r.price_cents }));
    }

    // price_range
    const minCents = rule.minCents ?? 0;
    const maxCents = rule.maxCents ?? Number.MAX_SAFE_INTEGER;
    const rows = await tx.execute(
      sql`
        SELECT p.id, p.title, p.slug,
          (SELECT MIN(v.price_cents) FROM variants v WHERE v.product_id = p.id) as price_cents
        FROM products p
        WHERE p.status = 'published'
          AND (
            SELECT MIN(v.price_cents) FROM variants v WHERE v.product_id = p.id
          ) BETWEEN ${minCents} AND ${maxCents}
        ORDER BY p.title
      `,
    );
    return (rows.rows as Array<{ id: string; title: string; slug: string; price_cents: number }>)
      .map((r) => ({ id: r.id, title: r.title, slug: r.slug, priceCents: r.price_cents }));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Discounts — Trigger + Reward + Conditions (Issue #12).
//
// The stacking engine (applyDiscounts) is the deep module — a pure function.
// The DB layer handles: persistence, code lookup, row-locked redemption,
// and idempotency (one redemption per discount+order).
// ─────────────────────────────────────────────────────────────────────────

import type { DiscountReward } from "./discounts";

/**
 * Create a discount (code-based or automatic).
 */
export async function createDiscount(
  storeId: string,
  opts: {
    name: string;
    trigger: object;
    reward: DiscountReward;
    conditions?: object;
  },
): Promise<{ id: string }> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`INSERT INTO discounts (name, trigger, reward, conditions) VALUES (${opts.name}, ${JSON.stringify(opts.trigger)}, ${JSON.stringify(opts.reward)}, ${opts.conditions ? JSON.stringify(opts.conditions) : null}) RETURNING id`,
    );
    return { id: (rows.rows[0] as { id: string }).id };
  });
}

/**
 * List all discounts in a Store.
 */
export async function listDiscounts(
  storeId: string,
): Promise<Array<{ id: string; name: string; active: boolean; usageCount: number }>> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, name, active, usage_count FROM discounts ORDER BY created_at DESC`,
    );
    const discounts = (rows.rows as Array<{ id: string; name: string; active: boolean; usage_count: number }>)
      .map((r) => ({ id: r.id, name: r.name, active: r.active, usageCount: r.usage_count }));
    return discounts;
  });
}

/**
 * Look up a discount by its code (for checkout).
 */
export async function getDiscountByCode(
  storeId: string,
  code: string,
): Promise<{ id: string; reward: DiscountReward; conditions: object | null } | null> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, reward, conditions FROM discounts WHERE trigger->>'code' = ${code} AND active = true LIMIT 1`,
    );
    if (rows.rows.length === 0) return null;
    const r = rows.rows[0] as { id: string; reward: DiscountReward; conditions: object | null };
    return { id: r.id, reward: r.reward, conditions: r.conditions };
  });
}

/**
 * Redeem a discount for an order — ROW-LOCKED for usage-limit safety.
 *
 * 1. SELECT ... FOR UPDATE on the discount (serializes concurrent redemptions).
 * 2. Check if already redeemed for this order (idempotency — UNIQUE constraint).
 * 3. Check usage limit (if set in conditions).
 * 4. Increment usage_count + insert redemption.
 *
 * Returns:
 * - { ok: true } on first redemption.
 * - { ok: false, reason: "already_redeemed" } if this discount+order already exists.
 * - { ok: false, reason: "usage_limit_reached" } if the limit is exceeded.
 */
export async function redeemDiscount(
  storeId: string,
  discountId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; reason: "already_redeemed" | "usage_limit_reached" }> {
  return tenantClient(storeId, async (tx) => {
    // 1. Row-lock the discount.
    const rows = await tx.execute(
      sql`SELECT usage_count, conditions FROM discounts WHERE id = ${discountId} FOR UPDATE`,
    );
    if (rows.rows.length === 0) {
      throw new Error(`Discount ${discountId} not found`);
    }
    const discount = rows.rows[0] as { usage_count: number; conditions: { usageLimit?: number } | null };

    // 2. Idempotency — already redeemed for this order?
    const existing = await tx.execute(
      sql`SELECT id FROM discount_redemptions WHERE discount_id = ${discountId} AND order_id = ${orderId} LIMIT 1`,
    );
    if (existing.rows.length > 0) {
      return { ok: false, reason: "already_redeemed" };
    }

    // 3. Usage limit check.
    if (discount.conditions?.usageLimit !== undefined) {
      if (discount.usage_count >= discount.conditions.usageLimit) {
        return { ok: false, reason: "usage_limit_reached" };
      }
    }

    // 4. Increment usage + record redemption.
    await tx.execute(
      sql`UPDATE discounts SET usage_count = usage_count + 1, updated_at = now() WHERE id = ${discountId}`,
    );
    await tx.execute(
      sql`INSERT INTO discount_redemptions (discount_id, order_id) VALUES (${discountId}, ${orderId})`,
    );

    return { ok: true as const };
  });
}




// ─────────────────────────────────────────────────────────────────────────
// Customer identity — per-Store, RLS-protected (Issue #13).
//
// Customers are SEPARATE from Merchants (global/better-auth). A Customer
// belongs to exactly one Store. All queries run through tenantClient (RLS).
// ─────────────────────────────────────────────────────────────────────────

import { hashPassword, verifyPassword } from "./customer-auth";

/** Session expiry: 30 days. */
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Sign up a new Customer in a Store.
 * Throws if a customer with this email already exists in this Store.
 */
export async function signUpCustomer(
  storeId: string,
  opts: { email: string; password: string; name: string },
): Promise<{ customerId: string }> {
  const passwordHash = hashPassword(opts.password);
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`INSERT INTO customers (email, name, password_hash) VALUES (${opts.email}, ${opts.name}, ${passwordHash}) RETURNING id`,
    );
    return { customerId: (rows.rows[0] as { id: string }).id };
  });
}

/**
 * Sign in a Customer — returns a session token, or null if credentials are wrong.
 */
export async function signInCustomer(
  storeId: string,
  opts: { email: string; password: string },
): Promise<{ token: string; customerId: string } | null> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, password_hash FROM customers WHERE email = ${opts.email} LIMIT 1`,
    );
    if (rows.rows.length === 0) return null;
    const customer = rows.rows[0] as { id: string; password_hash: string };
    if (!verifyPassword(opts.password, customer.password_hash)) return null;
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await tx.execute(
      sql`INSERT INTO customer_sessions (customer_id, token, expires_at) VALUES (${customer.id}, ${token}, ${expiresAt})`,
    );
    return { token, customerId: customer.id };
  });
}

/**
 * Resolve a session token to the Customer (for request-time auth).
 */
export async function getCustomerBySession(
  storeId: string,
  token: string,
): Promise<{ id: string; email: string; name: string } | null> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT c.id, c.email, c.name FROM customers c JOIN customer_sessions s ON s.customer_id = c.id WHERE s.token = ${token} AND s.expires_at > now() LIMIT 1`,
    );
    if (rows.rows.length === 0) return null;
    return rows.rows[0] as { id: string; email: string; name: string };
  });
}

/**
 * List all Customers in a Store (for the dashboard).
 */
export async function listCustomers(
  storeId: string,
): Promise<Array<{ id: string; email: string; name: string }>> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(sql`SELECT id, email, name FROM customers ORDER BY created_at DESC`);
    return rows.rows as Array<{ id: string; email: string; name: string }>;
  });
}

/**
 * List a Customer's orders (order history).
 */
export async function listCustomerOrders(
  storeId: string,
  customerId: string,
): Promise<Array<{ id: string; paymentStatus: string; fulfillmentStatus: string; totalCents: number }>> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, payment_status, fulfillment_status, total_cents FROM orders WHERE customer_id = ${customerId} ORDER BY created_at DESC`,
    );
    return (rows.rows as Array<{ id: string; payment_status: string; fulfillment_status: string; total_cents: number }>)
      .map((r) => ({ id: r.id, paymentStatus: r.payment_status, fulfillmentStatus: r.fulfillment_status, totalCents: r.total_cents }));
  });
}

/**
 * Add an address to a Customer's address book.
 */
export async function addCustomerAddress(
  storeId: string,
  customerId: string,
  opts: { fullName: string; line1: string; line2?: string; city: string; region: string; postalCode: string; country: string; phone?: string },
): Promise<{ id: string }> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`INSERT INTO addresses (customer_id, full_name, line1, line2, city, region, postal_code, country, phone) VALUES (${customerId}, ${opts.fullName}, ${opts.line1}, ${opts.line2 ?? null}, ${opts.city}, ${opts.region}, ${opts.postalCode}, ${opts.country}, ${opts.phone ?? null}) RETURNING id`,
    );
    return { id: (rows.rows[0] as { id: string }).id };
  });
}

/**
 * List a Customer's addresses.
 */
export async function listCustomerAddresses(
  storeId: string,
  customerId: string,
): Promise<Array<{ id: string; fullName: string; line1: string; line2: string | null; city: string; region: string; postalCode: string; country: string }>> {
  return tenantClient(storeId, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, full_name, line1, line2, city, region, postal_code, country FROM addresses WHERE customer_id = ${customerId} ORDER BY created_at DESC`,
    );
    return (rows.rows as Array<{ id: string; full_name: string; line1: string; line2: string | null; city: string; region: string; postal_code: string; country: string }>)
      .map((r) => ({ id: r.id, fullName: r.full_name, line1: r.line1, line2: r.line2, city: r.city, region: r.region, postalCode: r.postal_code, country: r.country }));
  });
}


// ─────────────────────────────────────────────────────────────────────────
// Platform billing — Tiers / Subscriptions (Issue #15).
//
// A Store holds one Subscription to a Tier at a time. The Tier determines
// its usage limits (Free = hard cap, Pro/Scale = overage). shp0 takes no
// Commission on any Tier (ADR-0007).
// ─────────────────────────────────────────────────────────────────────────

import { TIERS } from "./billing";
import type { Tier } from "./billing";

/**
 * Get a Store's current tier (defaults to 'free' if no subscription).
 * Platform-scoped — subscriptions are cross-Store.
 */
export async function getStoreTier(storeId: string): Promise<Tier> {
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT tier_id FROM subscriptions WHERE store_id = ${storeId} AND status = 'active' LIMIT 1`,
    );
    if (rows.rows.length === 0) return TIERS.free;
    const tierId = rows.rows[0]!.tier_id as "free" | "pro" | "scale";
    return TIERS[tierId];
  });
}

/**
 * Subscribe a Store to a Tier (or change tiers — upgrade/downgrade).
 * One active subscription per Store (UNIQUE on store_id).
 */
export async function setStoreTier(
  storeId: string,
  tierId: "free" | "pro" | "scale",
): Promise<void> {
  // tier_id is free text: an unknown id would be stored, and getStoreTier
  // would then return undefined for it.
  if (typeof tierId !== "string" || !Object.hasOwn(TIERS, tierId)) {
    throw new Error("Unknown tier");
  }
  return platformClient(async (tx) => {
    await tx.execute(
      sql`
        INSERT INTO subscriptions (store_id, tier_id)
        VALUES (${storeId}, ${tierId})
        ON CONFLICT (store_id) DO UPDATE SET
          tier_id = EXCLUDED.tier_id,
          status = 'active',
          updated_at = now()
      `,
    );
  });
}

/**
 * Meter current usage for a Store (for the usage policy evaluator).
 * Counts products, orders this month, and staff seats.
 */
export async function getStoreUsage(storeId: string): Promise<{
  productCount: number;
  orderCountThisMonth: number;
  staffSeats: number;
}> {
  return platformClient(async (tx) => {
    const productRows = await tx.execute(
      sql`SELECT COUNT(*) as count FROM products WHERE store_id = ${storeId}`,
    );
    const orderRows = await tx.execute(
      sql`SELECT COUNT(*) as count FROM orders WHERE store_id = ${storeId} AND date_trunc('month', created_at) = date_trunc('month', now())`,
    );
    const staffRows = await tx.execute(
      sql`SELECT COUNT(*) as count FROM memberships WHERE store_id = ${storeId}`,
    );
    return {
      productCount: parseInt(productRows.rows[0]!.count as string),
      orderCountThisMonth: parseInt(orderRows.rows[0]!.count as string),
      staffSeats: parseInt(staffRows.rows[0]!.count as string),
    };
  });
}


// ─────────────────────────────────────────────────────────────────────────
// Platform admin — operator surface (Issue #16).
//
// THE legitimate use of platformClient: cross-Store reads and operator actions.
// Tenant clients are never used here. Guarded to platform operators only.
// ─────────────────────────────────────────────────────────────────────────

import { transitionStoreStatus } from "./store-status";
import type { StoreStatus, StoreEvent } from "./store-status";

/**
 * List ALL Stores with their Owners — cross-Store operator view.
 * Platform-scoped via platformClient.
 */
export async function listAllStoresForOperator(): Promise<
  Array<{
    id: string;
    name: string;
    subdomain: string;
    status: string;
    ownerName: string | null;
    ownerEmail: string | null;
    orderCount: number;
    createdAt: Date;
  }>
> {
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`
        SELECT
          s.id, s.name, s.subdomain, s.status, s.created_at,
          u.name as owner_name, u.email as owner_email,
          (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.id) as order_count
        FROM stores s
        LEFT JOIN memberships m ON m.store_id = s.id AND m.role = 'owner'
        LEFT JOIN "user" u ON u.id = m.user_id
        ORDER BY s.created_at DESC
      `,
    );
    const result = (rows.rows as Array<{
      id: string; name: string; subdomain: string; status: string; created_at: Date;
      owner_name: string | null; owner_email: string | null; order_count: string;
    }>).map((r) => ({
      id: r.id,
      name: r.name,
      subdomain: r.subdomain,
      status: r.status,
      ownerName: r.owner_name,
      ownerEmail: r.owner_email,
      orderCount: parseInt(r.order_count),
      createdAt: r.created_at,
    }));
    return result;
  });
}

/**
 * Platform analytics: active store count + GMV (Gross Merchandise Value).
 * GMV = sum of all paid orders' totals across all stores.
 * Platform-scoped via platformClient.
 */
export async function getPlatformAnalytics(): Promise<{
  totalStores: number;
  activeStores: number;
  suspendedStores: number;
  terminatedStores: number;
  gmvCents: number;
  totalOrders: number;
}> {
  return platformClient(async (tx) => {
    const storeRows = await tx.execute(
      sql`SELECT status, COUNT(*) as count FROM stores GROUP BY status`,
    );
    const statusCounts: Record<string, number> = {};
    let totalStores = 0;
    for (const row of storeRows.rows as Array<{ status: string; count: string }>) {
      statusCounts[row.status] = parseInt(row.count);
      totalStores += parseInt(row.count);
    }

    const gmvRows = await tx.execute(
      sql`SELECT COALESCE(SUM(total_cents), 0) as gmv, COUNT(*) as order_count FROM orders WHERE payment_status = 'paid'`,
    );
    const gmvData = gmvRows.rows[0] as { gmv: string; order_count: string };

    return {
      totalStores,
      activeStores: statusCounts["active"] ?? 0,
      suspendedStores: statusCounts["suspended"] ?? 0,
      terminatedStores: statusCounts["terminated"] ?? 0,
      gmvCents: parseInt(gmvData.gmv),
      totalOrders: parseInt(gmvData.order_count),
    };
  });
}

/**
 * Suspend, reinstate, or terminate a Store (operator action).
 * Uses the pure state machine to validate the transition, then updates the DB.
 *
 * The Store row is locked before its status is read, so two concurrent
 * changes run one after the other and the second is validated against the
 * first one's result: a terminated Store is never reinstated, and an active
 * Store is never terminated without being suspended first. The lock is FOR
 * NO KEY UPDATE, the one the UPDATE takes anyway: status is not a key, so
 * foreign-key checks on the Store (new Memberships, payment accounts) do not
 * wait for it.
 */
export async function applyStoreStatusAction(
  storeId: string,
  event: StoreEvent,
): Promise<{ ok: true } | { ok: false; reason: "invalid_transition" }> {
  return platformClient(async (tx) => {
    // Read current status, holding the row lock until COMMIT.
    const rows = await tx.execute(
      sql`SELECT status FROM stores WHERE id = ${storeId} FOR NO KEY UPDATE`,
    );
    if (rows.rows.length === 0) {
      throw new Error(`Store ${storeId} not found`);
    }
    const currentStatus = rows.rows[0]!.status as StoreStatus;

    // Validate the transition via the pure state machine.
    const result = transitionStoreStatus(currentStatus, event);
    if (!result.ok) {
      return result;
    }

    // Apply the transition.
    await tx.execute(
      sql`UPDATE stores SET status = ${result.status} WHERE id = ${storeId}`,
    );

    return { ok: true as const };
  });
}


// ─────────────────────────────────────────────────────────────────────────
// Custom Domains — host→Store mapping + verification lifecycle (Issue #14).
//
// PLATFORM table (no RLS, no grant to "default") — the host-to-Store
// resolution runs before we know the Store. Only VERIFIED domains resolve to a
// Store (security). Because RLS does not scope this table, every per-Store
// read or write below carries an explicit `store_id` predicate; the caller
// must already have authorized the Merchant for that Store.
// ─────────────────────────────────────────────────────────────────────────

import { transitionDomainVerification } from "./domain-verification";
import type { DomainVerificationStatus, DomainVerificationEvent } from "./domain-verification";
import {
  InvalidCustomDomainError,
  customDomainRejectionMessage,
  routeStorefrontHost,
  validateCustomDomain,
} from "./hostname";

/**
 * Add a Custom Domain to a Store (starts as 'pending').
 *
 * The hostname is validated and normalized first (see validateCustomDomain):
 * the platform domain and its subdomains, URLs, IP literals, wildcards and
 * other malformed names throw InvalidCustomDomainError and store nothing. So
 * does a hostname that is already stored, for this Store or another one
 * (reason "already_added").
 * Detects apex vs subdomain automatically.
 */
export async function addCustomDomain(
  storeId: string,
  hostname: string,
): Promise<{ id: string; txtVerificationValue: string }> {
  const validated = validateCustomDomain(hostname);
  if (!validated.ok) throw new InvalidCustomDomainError(validated.reason, validated.message);
  const normalized = validated.hostname;

  // Detect apex: a hostname with no dots (after the TLD) is apex.
  // Simple heuristic: if it has exactly 1 dot (e.g. "acme.com") it's apex.
  // If it has 2+ dots (e.g. "shop.acme.com") it's a subdomain.
  const dotCount = (normalized.match(/\./g) || []).length;
  const isApex = dotCount === 1;
  const txtValue = `shp0-verify=${randomUUID()}`;

  const id = await platformClient(async (tx) => {
    // hostname is UNIQUE across all Stores. A hostname that is already stored
    // inserts nothing, and is reported as a typed error instead of a raw
    // unique violation.
    const rows = await tx.execute(
      sql`INSERT INTO custom_domains (store_id, hostname, is_apex, txt_verification_value) VALUES (${storeId}, ${normalized}, ${isApex}, ${txtValue}) ON CONFLICT (hostname) DO NOTHING RETURNING id`,
    );
    return (rows.rows[0] as { id: string } | undefined)?.id;
  });
  if (!id) {
    throw new InvalidCustomDomainError("already_added", customDomainRejectionMessage("already_added"));
  }
  return { id, txtVerificationValue: txtValue };
}

async function findVerifiedCustomDomainStore(hostname: string): Promise<string | null> {
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT store_id FROM custom_domains WHERE hostname = ${hostname} AND verification_status = 'verified' LIMIT 1`,
    );
    if (rows.rows.length === 0) return null;
    return rows.rows[0]!.store_id as string;
  });
}

/**
 * Resolve a host to a Store — ONLY if the domain is VERIFIED.
 * Returns null for pending/failed/unknown hosts (no Current Store = security).
 *
 * The host is normalized first (lowercase, port and one trailing dot
 * stripped). The platform domain and its subdomains always return null: they
 * are never resolved through the Custom Domain table, whatever it holds.
 */
export async function resolveStoreByCustomDomain(
  host: string,
): Promise<string | null> {
  const route = routeStorefrontHost(host);
  if (route.kind !== "custom_domain") return null;
  return findVerifiedCustomDomainStore(route.hostname);
}

/**
 * Resolve a storefront request host to a Store (ADR-0005 resolution order).
 *
 * The platform domain and its subdomains are decided by Subdomain resolution
 * only; any other host by a VERIFIED Custom Domain only. See
 * routeStorefrontHost for the pure decision.
 */
export async function resolveStoreByHost(host: string): Promise<string | null> {
  const route = routeStorefrontHost(host);
  switch (route.kind) {
    case "subdomain":
      return resolveStoreBySubdomain(route.subdomain);
    case "custom_domain":
      return findVerifiedCustomDomainStore(route.hostname);
    case "none":
      return null;
  }
}

/**
 * Apply a verification result to one of a Store's custom domains (via the
 * pure state machine). Intended for the DNS verification job; the dashboard
 * only sends "retry".
 *
 * Scoped by BOTH store id and domain id: a domain that belongs to another
 * Store is reported exactly like one that does not exist ("not_found"), and
 * is left unchanged.
 *
 * The domain row is locked (FOR NO KEY UPDATE, as in applyStoreStatusAction)
 * before its status is read, so two concurrent events run one after the
 * other and the second is validated against the first one's result: a domain
 * that has just failed is not verified again without a retry.
 */
export async function applyDomainVerification(
  storeId: string,
  domainId: string,
  event: DomainVerificationEvent,
): Promise<
  | { ok: true; status: DomainVerificationStatus }
  | { ok: false; reason: "invalid_transition" | "not_found" }
> {
  if (!UUID.test(storeId) || !UUID.test(domainId)) return { ok: false, reason: "not_found" };

  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT verification_status FROM custom_domains WHERE id = ${domainId} AND store_id = ${storeId} FOR NO KEY UPDATE`,
    );
    if (rows.rows.length === 0) return { ok: false, reason: "not_found" } as const;
    const current = rows.rows[0]!.verification_status as DomainVerificationStatus;

    const result = transitionDomainVerification(current, event);
    if (!result.ok) return result;

    const lastVerified = result.status === "verified" ? sql`now()` : sql`last_verified_at`;
    await tx.execute(
      sql`UPDATE custom_domains SET verification_status = ${result.status}, last_verified_at = ${lastVerified}, updated_at = now() WHERE id = ${domainId} AND store_id = ${storeId}`,
    );

    return { ok: true, status: result.status } as const;
  });
}

/**
 * List all custom domains for a Store (dashboard view), with the TXT value
 * the Merchant is asked to publish.
 */
export async function listCustomDomains(
  storeId: string,
): Promise<
  Array<{
    id: string;
    hostname: string;
    verificationStatus: string;
    isApex: boolean;
    txtVerificationValue: string | null;
  }>
> {
  return platformClient(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, hostname, verification_status, is_apex, txt_verification_value FROM custom_domains WHERE store_id = ${storeId} ORDER BY created_at DESC`,
    );
    return (
      rows.rows as Array<{
        id: string;
        hostname: string;
        verification_status: string;
        is_apex: boolean;
        txt_verification_value: string | null;
      }>
    ).map((r) => ({
      id: r.id,
      hostname: r.hostname,
      verificationStatus: r.verification_status,
      isApex: r.is_apex,
      txtVerificationValue: r.txt_verification_value,
    }));
  });
}







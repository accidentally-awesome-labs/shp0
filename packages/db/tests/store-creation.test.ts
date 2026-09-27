import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { sql } from "drizzle-orm";

import {
  applySchema,
  checkSubdomainAvailable,
  closePools,
  platformClient,
  provisionStore,
} from "../src/index";

/**
 * A Store always has exactly one Owner (CONTEXT.md: Owner), from the moment
 * it exists.
 *
 * provisionStore inserts the Store row and then its creator's Owner
 * Membership. platformClient ran its callback without BEGIN, so the two
 * inserts committed one by one: when the Membership insert failed (an
 * unknown ownerId), the Store row stayed behind with no Owner. Now
 * platformClient runs its callback in one transaction, like tenantClient,
 * and stores_exactly_one_owner_at_creation checks at COMMIT that every Store
 * the transaction inserted has exactly one Owner.
 *
 * Statements outside provisionStore and platformClient go through
 * node-postgres directly, so each refusal is checked by SQLSTATE (23000 is
 * integrity_constraint_violation, 23503 foreign_key_violation, 23505
 * unique_violation) and constraint name, and by the rows left behind.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";

/** The refusal of a transaction that creates `storeId` without exactly one Owner. */
function creationRefusal(storeId: string, owners = 0) {
  return {
    code: "23000",
    constraint: "stores_exactly_one_owner_at_creation",
    table: "stores",
    message: expect.stringMatching(
      new RegExp(
        `^Store ${storeId} must have exactly one Owner when it is created; this transaction creates it with ${owners}\\.$`,
      ),
    ),
  };
}

type Statement = [text: string, values?: unknown[]];

describe("Store creation: atomic, and never without its Owner", () => {
  let pool: Pool;

  /** A new Merchant (user) with no Membership anywhere. */
  async function newUser(label: string): Promise<string> {
    const id = `${label}-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      label,
      `${id}@store-creation.test`,
    ]);
    return id;
  }

  const newSubdomain = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

  async function storesWithSubdomain(subdomain: string) {
    const { rows } = await pool.query(`SELECT * FROM stores WHERE subdomain = $1`, [subdomain]);
    return rows;
  }

  async function storeExists(storeId: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM stores WHERE id = $1`, [storeId]);
    return rows.length === 1;
  }

  /** Every Membership of the Store, as [user id, role], in a stable order. */
  async function membershipsOf(storeId: string): Promise<Array<[string, string]>> {
    const { rows } = await pool.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM memberships WHERE store_id = $1 ORDER BY user_id`,
      [storeId],
    );
    return rows.map((r) => [r.user_id, r.role]);
  }

  async function membershipCountOf(userId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships WHERE user_id = $1`,
      [userId],
    );
    return rows[0]!.n;
  }

  async function processedEventExists(id: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM processed_events WHERE id = $1`, [id]);
    return rows.length === 1;
  }

  /**
   * Run the statements in one transaction on a connection of its own, then
   * COMMIT. Resolves with the COMMIT's error (null when it committed). A
   * statement that fails rolls the transaction back and rejects with its
   * error.
   */
  async function transaction(statements: Statement[]): Promise<{ commitError: unknown }> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        for (const [text, values] of statements) await client.query(text, values);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      const commitError = await client.query("COMMIT").then(
        () => null,
        (error: unknown) => error,
      );
      return { commitError };
    } finally {
      client.release();
    }
  }

  const insertStore = (storeId: string, subdomain = newSubdomain("raw")): Statement => [
    `INSERT INTO public.stores (id, store_id, name, subdomain) VALUES ($1, $1, 'Raw', $2)`,
    [storeId, subdomain],
  ];
  const insertMembership = (storeId: string, userId: string, role: string): Statement => [
    `INSERT INTO public.memberships (user_id, store_id, role) VALUES ($1, $2, $3)`,
    [userId, storeId, role],
  ];
  /** Give the Store another id (a Store's own row carries store_id = id). */
  const changeStoreId = (storeId: string, newId: string): Statement => [
    `UPDATE public.stores SET id = $2, store_id = $2 WHERE id = $1`,
    [storeId, newId],
  ];

  /**
   * An existing Store with no Owner and no Membership: legacy data, from
   * before the creation-time check. Made with that check off, in one
   * committed transaction on one connection (disable, insert, enable), as
   * owner-invariant.test.ts does; then the trigger is checked to be on.
   */
  async function legacyOwnerlessStore(): Promise<string> {
    const storeId = randomUUID();
    await transaction([
      [`ALTER TABLE stores DISABLE TRIGGER stores_exactly_one_owner_at_creation`],
      insertStore(storeId, newSubdomain("legacy")),
      [`ALTER TABLE stores ENABLE TRIGGER stores_exactly_one_owner_at_creation`],
    ]).then(({ commitError }) => {
      if (commitError) throw commitError;
    });
    const { rows } = await pool.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger
       WHERE tgrelid = 'stores'::regclass AND tgname = 'stores_exactly_one_owner_at_creation'`,
    );
    expect(rows).toEqual([{ tgenabled: "O" }]);
    expect(await storeExists(storeId)).toBe(true);
    expect(await membershipsOf(storeId)).toEqual([]);
    return storeId;
  }

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: PLATFORM_URL });
    await pool.query(
      `TRUNCATE memberships, stores, processed_events, "user", "session", "account", "verification" CASCADE`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await closePools();
  });

  describe("platformClient runs its callback in one transaction", () => {
    it("commits the callback's writes when it returns", async () => {
      const id = `evt-${randomUUID()}`;
      await platformClient((tx) => tx.execute(sql`INSERT INTO processed_events (id) VALUES (${id})`));
      expect(await processedEventExists(id)).toBe(true);
    });

    it("no other connection sees a write before the callback returns", async () => {
      const id = `evt-${randomUUID()}`;
      const seenInside = await platformClient(async (tx) => {
        await tx.execute(sql`INSERT INTO processed_events (id) VALUES (${id})`);
        return processedEventExists(id);
      });
      expect(seenInside).toBe(false);
      expect(await processedEventExists(id)).toBe(true);
    });

    it("rolls a write back when the callback throws after it", async () => {
      const id = `evt-${randomUUID()}`;
      await expect(
        platformClient(async (tx) => {
          await tx.execute(sql`INSERT INTO processed_events (id) VALUES (${id})`);
          throw new Error("callback failed after its write");
        }),
      ).rejects.toThrow("callback failed after its write");
      expect(await processedEventExists(id)).toBe(false);
    });

    it("rolls every earlier write back when a later statement fails, and rejects with that statement's error", async () => {
      const id = `evt-${randomUUID()}`;
      await expect(
        platformClient(async (tx) => {
          await tx.execute(sql`INSERT INTO processed_events (id) VALUES (${id})`);
          await tx.execute(sql`INSERT INTO processed_events (id) VALUES (${id})`);
        }),
      ).rejects.toMatchObject({ code: "23505", constraint: "processed_events_pkey" });
      expect(await processedEventExists(id)).toBe(false);
    });
  });

  describe("provisionStore is atomic", () => {
    it("creates the Store with exactly one Owner: its creator, and no other Membership", async () => {
      const owner = await newUser("owner");
      const { store } = await provisionStore({
        name: "Creator owns it",
        subdomain: newSubdomain("owned"),
        ownerId: owner,
      });
      expect(store.storeId).toBe(store.id);
      expect(await membershipsOf(store.id)).toEqual([[owner, "owner"]]);
    });

    it("with an unknown ownerId it throws and leaves no Store behind", async () => {
      const subdomain = newSubdomain("no-owner");
      await expect(
        provisionStore({ name: "Nobody owns it", subdomain, ownerId: `unknown-${randomUUID()}` }),
      ).rejects.toMatchObject({ code: "23503", constraint: "memberships_user_id_fkey" });

      expect(await storesWithSubdomain(subdomain)).toEqual([]);
      expect(await checkSubdomainAvailable(subdomain)).toBe(true);

      // The subdomain is free for the next Merchant who asks for it.
      const owner = await newUser("next");
      const { store } = await provisionStore({ name: "Owned", subdomain, ownerId: owner });
      expect(await membershipsOf(store.id)).toEqual([[owner, "owner"]]);
    });

    it("two concurrent calls for one subdomain: one wins, the loser leaves nothing behind", async () => {
      const subdomain = newSubdomain("race");
      const first = await newUser("first");
      const second = await newUser("second");

      const [a, b] = await Promise.allSettled([
        provisionStore({ name: "First", subdomain, ownerId: first }),
        provisionStore({ name: "Second", subdomain, ownerId: second }),
      ]);

      const won = [a, b].filter((r) => r.status === "fulfilled");
      const lost = [a, b].filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.reason).toMatchObject({ code: "23505", constraint: "stores_subdomain_key" });

      const [winner, loser] = a.status === "fulfilled" ? [first, second] : [second, first];
      const stores = await storesWithSubdomain(subdomain);
      expect(stores).toHaveLength(1);
      expect(await membershipsOf(stores[0]!.id)).toEqual([[winner, "owner"]]);
      expect(await membershipCountOf(loser)).toBe(0);
    });

    /**
     * Three real connections, interleaved on purpose. Session `gate` locks
     * memberships, so the first provisionStore call (unknown ownerId) has
     * inserted its Store row and waits to insert the Membership; only then
     * does the second call (a real Merchant) ask for the same subdomain.
     * The test waits until the server reports each call as waiting on a
     * lock, so the interleaving is the one named.
     */
    it("a call that fails after its Store row holds the subdomain only until it rolls back: a concurrent call for it then succeeds", async () => {
      const subdomain = newSubdomain("held");
      const merchant = await newUser("merchant");
      const gate = new Client({ connectionString: PLATFORM_URL });
      await gate.connect();
      let failing: Promise<unknown> | undefined;
      let real: Promise<unknown> | undefined;
      try {
        await gate.query("BEGIN");
        await gate.query("LOCK TABLE memberships IN SHARE MODE");

        failing = provisionStore({ name: "Failing", subdomain, ownerId: `unknown-${randomUUID()}` }).then(
          () => null,
          (error: unknown) => error,
        );
        await waitingOnLock(`insert into "memberships"`);

        let realSettled = false;
        real = provisionStore({ name: "Real", subdomain, ownerId: merchant }).then(
          (result) => result,
          (error: unknown) => ({ error }),
        );
        void real.finally(() => {
          realSettled = true;
        });
        // With one transaction per call, the second call waits for the first
        // one's Store row (the subdomain's unique index). Without it, the
        // first call's Store row is committed already, and the second call
        // fails at once.
        await waitingOnLock(`insert into "stores"`, () => realSettled);

        await gate.query("COMMIT");
      } finally {
        await gate.end();
      }

      expect(await failing).toMatchObject({ code: "23503", constraint: "memberships_user_id_fkey" });
      const result = await real;
      expect(result).toMatchObject({ store: { subdomain } });
      const stores = await storesWithSubdomain(subdomain);
      expect(stores).toHaveLength(1);
      expect(await membershipsOf(stores[0]!.id)).toEqual([[merchant, "owner"]]);
    }, 20000);

    /**
     * Resolves once another backend of this database runs a statement that
     * starts with `statementPrefix` and waits on a lock, or once `done()`
     * says there is nothing left to wait for.
     */
    async function waitingOnLock(statementPrefix: string, done: () => boolean = () => false) {
      for (let attempt = 0; attempt < 500; attempt++) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock' AND starts_with(query, $1)`,
          [statementPrefix],
        );
        if (rows.length > 0 || done()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no backend ever waited on a lock in ${JSON.stringify(statementPrefix)}`);
    }
  });

  describe("a new Store must have exactly one Owner when its transaction commits", () => {
    it("a Store inserted on its own (autocommit) is refused, and not created", async () => {
      const storeId = randomUUID();
      await expect(pool.query(...insertStore(storeId))).rejects.toMatchObject(creationRefusal(storeId));
      expect(await storeExists(storeId)).toBe(false);
    });

    it("a transaction that creates a Store with only an Admin is refused at COMMIT, and rolls back whole", async () => {
      const storeId = randomUUID();
      const admin = await newUser("admin");

      const { commitError } = await transaction([
        insertStore(storeId),
        insertMembership(storeId, admin, "admin"),
      ]);

      expect(commitError).toMatchObject(creationRefusal(storeId));
      expect(await storeExists(storeId)).toBe(false);
      expect(await membershipCountOf(admin)).toBe(0);
    });

    it("the Owner may be added by a later statement of the same transaction (the check runs at COMMIT)", async () => {
      const storeId = randomUUID();
      const owner = await newUser("owner");
      const staff = await newUser("staff");

      const { commitError } = await transaction([
        insertStore(storeId),
        insertMembership(storeId, staff, "staff"),
        insertMembership(storeId, owner, "owner"),
      ]);

      expect(commitError).toBeNull();
      // User ids start with their label, so the Owner sorts first.
      expect(await membershipsOf(storeId)).toEqual([
        [owner, "owner"],
        [staff, "staff"],
      ]);
    });

    it("a Store deleted in the same transaction that created it is not checked", async () => {
      const storeId = randomUUID();
      const { commitError } = await transaction([
        insertStore(storeId),
        [`DELETE FROM stores WHERE id = $1`, [storeId]],
      ]);
      expect(commitError).toBeNull();
      expect(await storeExists(storeId)).toBe(false);
    });

    /**
     * A Store with no Membership yet can still be given another id
     * (memberships' foreign key only stops that once a Membership points at
     * it). The Store under its new id is a new Store, so the check follows
     * it there: moving a new Store to another id does not skip the check.
     */
    describe("a Store given a new id is checked under that id", () => {
      it("a transaction that inserts a Store and changes its id is refused at COMMIT without an Owner, and rolls back whole", async () => {
        const storeId = randomUUID();
        const newId = randomUUID();

        const { commitError } = await transaction([insertStore(storeId), changeStoreId(storeId, newId)]);

        expect(commitError).toMatchObject({
          ...creationRefusal(newId),
          detail: `This transaction changed its id from ${storeId}.`,
        });
        expect(await storeExists(storeId)).toBe(false);
        expect(await storeExists(newId)).toBe(false);
      });

      it("a platformClient callback that inserts a Store and changes its id is refused at COMMIT", async () => {
        const storeId = randomUUID();
        const newId = randomUUID();
        await expect(
          platformClient(async (tx) => {
            await tx.execute(
              sql`INSERT INTO stores (id, store_id, name, subdomain) VALUES (${storeId}, ${storeId}, 'Raw', ${newSubdomain("pc")})`,
            );
            await tx.execute(sql`UPDATE stores SET id = ${newId}, store_id = ${newId} WHERE id = ${storeId}`);
          }),
        ).rejects.toMatchObject(creationRefusal(newId));
        expect(await storeExists(storeId)).toBe(false);
        expect(await storeExists(newId)).toBe(false);
      });

      it("the transaction commits when it gives the Store its Owner under the new id", async () => {
        const storeId = randomUUID();
        const newId = randomUUID();
        const owner = await newUser("owner");

        const { commitError } = await transaction([
          insertStore(storeId),
          changeStoreId(storeId, newId),
          insertMembership(newId, owner, "owner"),
        ]);

        expect(commitError).toBeNull();
        expect(await storeExists(storeId)).toBe(false);
        expect(await membershipsOf(newId)).toEqual([[owner, "owner"]]);
      });

      it("an existing ownerless Store given a new id must get its Owner in that transaction", async () => {
        const storeId = await legacyOwnerlessStore();
        const newId = randomUUID();

        const { commitError } = await transaction([changeStoreId(storeId, newId)]);
        expect(commitError).toMatchObject(creationRefusal(newId));
        expect(await storeExists(storeId)).toBe(true);
        expect(await storeExists(newId)).toBe(false);

        const owner = await newUser("owner");
        const retry = await transaction([changeStoreId(storeId, newId), insertMembership(newId, owner, "owner")]);
        expect(retry.commitError).toBeNull();
        expect(await storeExists(storeId)).toBe(false);
        expect(await membershipsOf(newId)).toEqual([[owner, "owner"]]);
      });

      it("an existing ownerless Store is not checked by an UPDATE that keeps its id", async () => {
        const storeId = await legacyOwnerlessStore();

        const { commitError } = await transaction([
          [`UPDATE stores SET name = 'Renamed' WHERE id = $1`, [storeId]],
          // Names id, but keeps it: still the same Store, not a new one.
          [`UPDATE stores SET id = id, store_id = store_id, status = 'suspended' WHERE id = $1`, [storeId]],
        ]);

        expect(commitError).toBeNull();
        const { rows } = await pool.query(`SELECT name, status FROM stores WHERE id = $1`, [storeId]);
        expect(rows).toEqual([{ name: "Renamed", status: "suspended" }]);
        expect(await membershipsOf(storeId)).toEqual([]);
      });
    });

    it("a platformClient callback that inserts a Store without its Owner is refused at COMMIT", async () => {
      const storeId = randomUUID();
      await expect(
        platformClient((tx) =>
          tx.execute(
            sql`INSERT INTO stores (id, store_id, name, subdomain) VALUES (${storeId}, ${storeId}, 'Raw', ${newSubdomain("pc")})`,
          ),
        ),
      ).rejects.toMatchObject(creationRefusal(storeId));
      expect(await storeExists(storeId)).toBe(false);
    });
  });

  /**
   * The check must count the Owner rows of the real memberships table, and
   * see the real Store, whatever the committing session's search_path or
   * row-level security would show it (the same hardening as
   * memberships_exactly_one_owner, see owner-invariant.test.ts).
   */
  describe("the check reads the Store's own tables, whatever the session sees", () => {
    const DECOY = `store_creation_decoy_${randomUUID().replace(/-/g, "")}`;

    beforeAll(async () => {
      await pool.query(`
        CREATE SCHEMA "${DECOY}";
        CREATE TABLE "${DECOY}".stores (id uuid);
        CREATE TABLE "${DECOY}".memberships (store_id uuid, role text)`);
    });

    afterAll(async () => {
      await pool?.query(`DROP SCHEMA IF EXISTS "${DECOY}" CASCADE`);
    });

    it("a temporary table named memberships, holding an Owner row, does not stand in for the real one", async () => {
      const storeId = randomUUID();
      // pg_temp comes before public in a session's search_path unless the
      // path lists it, so an unqualified `memberships` would find this table.
      const { commitError } = await transaction([
        [`CREATE TEMP TABLE memberships (store_id uuid, role text) ON COMMIT DROP`],
        [`INSERT INTO pg_temp.memberships (store_id, role) VALUES ($1, 'owner')`, [storeId]],
        insertStore(storeId),
      ]);
      expect(commitError).toMatchObject(creationRefusal(storeId));
      expect(await storeExists(storeId)).toBe(false);
    });

    it("another schema's memberships, first on the search_path with an Owner row, does not stand in for the real one", async () => {
      const storeId = randomUUID();
      const { commitError } = await transaction([
        [`SET LOCAL search_path = "${DECOY}", public`],
        [`INSERT INTO "${DECOY}".memberships (store_id, role) VALUES ($1, 'owner')`, [storeId]],
        insertStore(storeId),
      ]);
      expect(commitError).toMatchObject(creationRefusal(storeId));
      expect(await storeExists(storeId)).toBe(false);
    });

    it("a Store that row-level security hides from the check is an error, not a skipped check", async () => {
      const storeId = randomUUID();
      const policy = `store_creation_insert_only_${randomUUID().replace(/-/g, "")}`;
      const forced = async () =>
        (
          await pool.query<{ relforcerowsecurity: boolean }>(
            `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'stores'::regclass`,
          )
        ).rows[0]!.relforcerowsecurity;

      try {
        // FORCE makes RLS apply to cloud_admin, the owner of stores; the only
        // policy for it lets it insert the Store but see no row, so the Store
        // is invisible at COMMIT.
        const { commitError } = await transaction([
          [`ALTER TABLE stores FORCE ROW LEVEL SECURITY`],
          [`CREATE POLICY ${policy} ON stores FOR INSERT TO cloud_admin WITH CHECK (true)`],
          insertStore(storeId),
        ]);

        expect(commitError).toMatchObject({
          code: "42501",
          message: 'query would be affected by row-level security policy for table "stores"',
        });
        expect(await forced()).toBe(false);
      } finally {
        // Only a check that skipped the hidden Store lets that transaction commit.
        await pool.query(`DROP POLICY IF EXISTS ${policy} ON stores`);
        if (await forced()) await pool.query(`ALTER TABLE stores NO FORCE ROW LEVEL SECURITY`);
      }
      expect(await storeExists(storeId)).toBe(false);
    });
  });
});

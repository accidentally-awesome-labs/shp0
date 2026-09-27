import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";

import { applySchema, closePools, provisionStore } from "../src/index";

/**
 * A Store always has exactly one Owner, who cannot be removed and cannot
 * leave without first transferring ownership; ownership transfer is atomic
 * (CONTEXT.md: Owner, Relationships).
 *
 * memberships_one_owner_per_store allows at most one 'owner' row per Store
 * and memberships_no_delete_owner refuses deleting a row whose role is
 * 'owner'. Neither stopped an UPDATE: demoting the Owner row (and then
 * deleting it), or moving it to another Store, left a Store with no Owner.
 * memberships_exactly_one_owner checks, at COMMIT, that every Store whose
 * Owner row a transaction changed still has exactly one Owner.
 *
 * Ownership transfer is not built yet, so it is written here in SQL, the
 * two ways the comment at the trigger in applySchema() describes.
 *
 * Every statement runs through node-postgres on real connections, so each
 * refusal is checked by SQLSTATE (23000 is integrity_constraint_violation,
 * 23505 unique_violation) and constraint name, and by the rows left behind.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";

/** The refusal of a transaction that would leave `storeId` without exactly one Owner. */
function ownerRefusal(storeId: string) {
  return {
    code: "23000",
    constraint: "memberships_exactly_one_owner",
    table: "memberships",
    message: expect.stringMatching(
      new RegExp(`^Store ${storeId} must have exactly one Owner; this transaction leaves it with 0\\.$`),
    ),
  };
}

type Statement = [text: string, values?: unknown[]];

describe("memberships: a Store keeps exactly one Owner", () => {
  let pool: Pool;

  /** A new Merchant (user) with no Membership anywhere. */
  async function newUser(label: string): Promise<string> {
    const id = `${label}-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      label,
      `${id}@owner-invariant.test`,
    ]);
    return id;
  }

  /**
   * A Store provisioned the way the app does it (its creator is the Owner),
   * plus an Admin and a Staff member, and a person with no Membership there.
   */
  async function newStore() {
    const owner = await newUser("owner");
    const admin = await newUser("admin");
    const staff = await newUser("staff");
    const outsider = await newUser("outsider");
    const { store } = await provisionStore({
      name: "Owner invariant",
      subdomain: `owner-inv-${randomUUID().slice(0, 8)}`,
      ownerId: owner,
    });
    await pool.query(
      `INSERT INTO memberships (user_id, store_id, role) VALUES ($1, $3, 'admin'), ($2, $3, 'staff')`,
      [admin, staff, store.id],
    );
    return { storeId: store.id, owner, admin, staff, outsider };
  }

  /**
   * A Store with no Owner at all. Only a fixture: the database does not
   * require an Owner when a Store is created (provisionStore inserts the
   * Owner row after the Store row), so a Store can be ownerless, and moving
   * an Owner row into one is not refused by memberships_one_owner_per_store.
   */
  async function newOwnerlessStore(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO stores (id, store_id, name, subdomain) VALUES ($1, $1, 'Ownerless', $2)`,
      [id, `ownerless-${id.slice(0, 8)}`],
    );
    return id;
  }

  /** Every Membership of the Store, whole rows, in a stable order. */
  async function membershipsOf(storeId: string) {
    const { rows } = await pool.query(
      `SELECT * FROM memberships WHERE store_id = $1 ORDER BY user_id`,
      [storeId],
    );
    return rows;
  }

  async function ownersOf(storeId: string): Promise<string[]> {
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE store_id = $1 AND role = 'owner' ORDER BY user_id`,
      [storeId],
    );
    return rows.map((r) => r.user_id);
  }

  async function roleOf(userId: string, storeId: string): Promise<string | null> {
    const { rows } = await pool.query<{ role: string }>(
      `SELECT role FROM memberships WHERE user_id = $1 AND store_id = $2`,
      [userId, storeId],
    );
    return rows[0]?.role ?? null;
  }

  async function userExists(userId: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [userId]);
    return rows.length === 1;
  }

  /**
   * Run the statements in one transaction, then COMMIT. Resolves with the
   * rows each statement changed and the COMMIT's error (null when it
   * committed). A statement that fails rolls the transaction back and
   * rejects with its error.
   */
  async function transaction(
    statements: Statement[],
  ): Promise<{ rowCounts: Array<number | null>; commitError: unknown }> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rowCounts: Array<number | null> = [];
      try {
        for (const [text, values] of statements) {
          rowCounts.push((await client.query(text, values)).rowCount);
        }
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      const commitError = await client.query("COMMIT").then(
        () => null,
        (error: unknown) => error,
      );
      return { rowCounts, commitError };
    } finally {
      client.release();
    }
  }

  const demoteOwner = (storeId: string, role = "admin"): Statement => [
    `UPDATE memberships SET role = $2 WHERE store_id = $1 AND role = 'owner'`,
    [storeId, role],
  ];
  const promote = (storeId: string, userId: string): Statement => [
    `UPDATE memberships SET role = 'owner' WHERE store_id = $1 AND user_id = $2`,
    [storeId, userId],
  ];
  const remove = (storeId: string, userId: string): Statement => [
    `DELETE FROM memberships WHERE store_id = $1 AND user_id = $2`,
    [storeId, userId],
  ];
  /** Closing a person's account: the cascade deletes each of their Memberships. */
  const deleteUser = (userId: string): Statement => [`DELETE FROM "user" WHERE id = $1`, [userId]];

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: PLATFORM_URL });
    await pool.query(
      `TRUNCATE memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await closePools();
  });

  it("provisionStore still makes the creator the Store's one Owner", async () => {
    const { storeId, owner, admin, staff } = await newStore();
    expect(await ownersOf(storeId)).toEqual([owner]);
    expect(await roleOf(admin, storeId)).toBe("admin");
    expect(await roleOf(staff, storeId)).toBe("staff");
  });

  describe("removing the Owner is refused at COMMIT, and changes nothing", () => {
    it("demoting the Owner row and committing", async () => {
      const { storeId } = await newStore();
      const before = await membershipsOf(storeId);

      const { rowCounts, commitError } = await transaction([demoteOwner(storeId)]);

      // The UPDATE itself went through; the check ran at COMMIT.
      expect(rowCounts).toEqual([1]);
      expect(commitError).toMatchObject(ownerRefusal(storeId));
      expect(await membershipsOf(storeId)).toEqual(before);
    });

    it("demoting the Owner row in a single autocommit statement", async () => {
      const { storeId } = await newStore();
      const before = await membershipsOf(storeId);

      await expect(pool.query(...demoteOwner(storeId, "staff"))).rejects.toMatchObject(
        ownerRefusal(storeId),
      );
      expect(await membershipsOf(storeId)).toEqual(before);
    });

    it("demoting the Owner row, then deleting it, in one transaction", async () => {
      const { storeId, owner } = await newStore();
      const before = await membershipsOf(storeId);

      // The DELETE passes memberships_no_delete_owner: the row is 'admin' by then.
      const { rowCounts, commitError } = await transaction([
        demoteOwner(storeId),
        remove(storeId, owner),
      ]);

      expect(rowCounts).toEqual([1, 1]);
      expect(commitError).toMatchObject(ownerRefusal(storeId));
      expect(await membershipsOf(storeId)).toEqual(before);
    });

    it("moving the Owner row to another Store (UPDATE store_id) is refused for the Store it leaves", async () => {
      const { storeId, owner } = await newStore();
      const elsewhere = await newOwnerlessStore();
      const before = await membershipsOf(storeId);

      const { rowCounts, commitError } = await transaction([
        [
          `UPDATE memberships SET store_id = $2 WHERE store_id = $1 AND role = 'owner'`,
          [storeId, elsewhere],
        ],
      ]);

      expect(rowCounts).toEqual([1]);
      expect(commitError).toMatchObject(ownerRefusal(storeId));
      expect(await membershipsOf(storeId)).toEqual(before);
      expect(await ownersOf(storeId)).toEqual([owner]);
      expect(await membershipsOf(elsewhere)).toEqual([]);
    });

    it("demoting the Owner row, then deleting the Owner's user, in one transaction", async () => {
      const { storeId, owner } = await newStore();
      const before = await membershipsOf(storeId);

      // The cascade deletes an 'admin' row by then, which memberships_no_delete_owner lets go.
      const { rowCounts, commitError } = await transaction([demoteOwner(storeId), deleteUser(owner)]);

      expect(rowCounts).toEqual([1, 1]);
      expect(commitError).toMatchObject(ownerRefusal(storeId));
      expect(await membershipsOf(storeId)).toEqual(before);
      expect(await userExists(owner)).toBe(true);
    });

    it("deleting the Owner row outright is still refused at once, by memberships_no_delete_owner", async () => {
      const { storeId, owner } = await newStore();
      await expect(pool.query(...remove(storeId, owner))).rejects.toMatchObject({
        code: "P0001",
        message: "Cannot delete an owner Membership. Transfer ownership first.",
      });
      expect(await ownersOf(storeId)).toEqual([owner]);
    });

    it("deleting the Owner's user (closing their account) is refused at once too: the cascade reaches the Owner row", async () => {
      const { storeId, owner } = await newStore();
      const before = await membershipsOf(storeId);
      await expect(pool.query(...deleteUser(owner))).rejects.toMatchObject({
        code: "P0001",
        message: "Cannot delete an owner Membership. Transfer ownership first.",
      });
      expect(await membershipsOf(storeId)).toEqual(before);
      expect(await userExists(owner)).toBe(true);
    });
  });

  describe("ownership transfer is still possible, and atomic", () => {
    it("to a person with no Membership in the Store: change the Owner row's user_id", async () => {
      const { storeId, owner, outsider } = await newStore();
      const [ownerRow] = (await membershipsOf(storeId)).filter((m) => m.role === "owner");

      const { rowCounts, commitError } = await transaction([
        [
          `UPDATE memberships SET user_id = $2 WHERE store_id = $1 AND role = 'owner'`,
          [storeId, outsider],
        ],
      ]);

      expect(rowCounts).toEqual([1]);
      expect(commitError).toBeNull();
      expect(await ownersOf(storeId)).toEqual([outsider]);
      // The same row, now held by the new Owner; the old Owner has no Membership.
      const [newOwnerRow] = (await membershipsOf(storeId)).filter((m) => m.role === "owner");
      expect(newOwnerRow).toEqual({ ...ownerRow, user_id: outsider });
      expect(await roleOf(owner, storeId)).toBeNull();
    });

    it("but not onto an existing member's user_id: one Membership per person per Store", async () => {
      const { storeId, owner, admin } = await newStore();
      await expect(
        transaction([
          [
            `UPDATE memberships SET user_id = $2 WHERE store_id = $1 AND role = 'owner'`,
            [storeId, admin],
          ],
        ]),
      ).rejects.toMatchObject({ code: "23505", constraint: "memberships_user_store_key" });
      expect(await ownersOf(storeId)).toEqual([owner]);
    });

    it("to an existing member: in one transaction, demote the Owner row first, then promote the member", async () => {
      const { storeId, owner, admin, staff } = await newStore();

      const { rowCounts, commitError } = await transaction([
        demoteOwner(storeId),
        promote(storeId, staff),
      ]);

      expect(rowCounts).toEqual([1, 1]);
      expect(commitError).toBeNull();
      expect(await ownersOf(storeId)).toEqual([staff]);
      expect(await roleOf(owner, storeId)).toBe("admin");
      expect(await roleOf(admin, storeId)).toBe("admin");
    });

    it("in the other order (promote first) it is refused at once by memberships_one_owner_per_store", async () => {
      const { storeId, owner, admin } = await newStore();
      const before = await membershipsOf(storeId);

      await expect(transaction([promote(storeId, admin), demoteOwner(storeId)])).rejects.toMatchObject({
        code: "23505",
        constraint: "memberships_one_owner_per_store",
      });
      expect(await membershipsOf(storeId)).toEqual(before);
      expect(await ownersOf(storeId)).toEqual([owner]);
    });

    it("after a transfer the old Owner, now an Admin, can be removed", async () => {
      const { storeId, owner, admin } = await newStore();
      expect((await transaction([demoteOwner(storeId), promote(storeId, admin)])).commitError).toBeNull();

      const { rowCounts, commitError } = await transaction([remove(storeId, owner)]);

      expect(rowCounts).toEqual([1]);
      expect(commitError).toBeNull();
      expect(await roleOf(owner, storeId)).toBeNull();
      expect(await ownersOf(storeId)).toEqual([admin]);
    });

    it("transfer and removal of the old Owner can happen in the same transaction", async () => {
      const { storeId, owner, admin } = await newStore();

      const { commitError } = await transaction([
        demoteOwner(storeId),
        promote(storeId, admin),
        remove(storeId, owner),
      ]);

      expect(commitError).toBeNull();
      expect(await roleOf(owner, storeId)).toBeNull();
      expect(await ownersOf(storeId)).toEqual([admin]);
    });

    it("after a transfer the old Owner can close their account", async () => {
      const { storeId, owner, admin } = await newStore();
      expect((await transaction([demoteOwner(storeId), promote(storeId, admin)])).commitError).toBeNull();

      const { rowCounts, commitError } = await transaction([deleteUser(owner)]);

      expect(rowCounts).toEqual([1]);
      expect(commitError).toBeNull();
      expect(await userExists(owner)).toBe(false);
      expect(await roleOf(owner, storeId)).toBeNull();
      expect(await ownersOf(storeId)).toEqual([admin]);
    });

    it("demoting the Owner and promoting them back in one transaction commits", async () => {
      const { storeId, owner } = await newStore();
      const { commitError } = await transaction([demoteOwner(storeId), promote(storeId, owner)]);
      expect(commitError).toBeNull();
      expect(await ownersOf(storeId)).toEqual([owner]);
    });
  });

  describe("Store deletion", () => {
    it("a Store deleted in the same transaction is not checked: this trigger never blocks Store deletion", async () => {
      const { storeId, admin } = await newStore();

      // The Owner row is 'admin' by the time the cascade deletes it, so the
      // older trigger lets it go; the Store it would have to keep is gone.
      const { commitError } = await transaction([
        demoteOwner(storeId),
        [`DELETE FROM stores WHERE id = $1`, [storeId]],
      ]);

      expect(commitError).toBeNull();
      expect(await membershipsOf(storeId)).toEqual([]);
      expect(await roleOf(admin, storeId)).toBeNull();
    });

    it("deleting a Store that still has its Owner is refused by memberships_no_delete_owner (the cascade deletes the Owner row)", async () => {
      const { storeId, owner } = await newStore();
      await expect(pool.query(`DELETE FROM stores WHERE id = $1`, [storeId])).rejects.toMatchObject({
        code: "P0001",
        message: "Cannot delete an owner Membership. Transfer ownership first.",
      });
      expect(await ownersOf(storeId)).toEqual([owner]);
    });

    it("why memberships_no_delete_owner stays: without it, the COMMIT-time check refuses deleting the Owner's user but lets a Store deletion take the Owner row", async () => {
      const { storeId, owner } = await newStore();
      const before = await membershipsOf(storeId);
      // One connection, one transaction that is always rolled back: the
      // older trigger is disabled only inside it, and SET CONSTRAINTS runs
      // the COMMIT-time check after each statement instead of at COMMIT.
      const client = new Client({ connectionString: PLATFORM_URL });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE memberships DISABLE TRIGGER memberships_no_delete_owner");
        await client.query("SET CONSTRAINTS memberships_exactly_one_owner IMMEDIATE");

        await client.query("SAVEPOINT close_account");
        await expect(client.query(...deleteUser(owner))).rejects.toMatchObject(ownerRefusal(storeId));
        await client.query("ROLLBACK TO SAVEPOINT close_account");

        // The check skips a Store that no longer exists, so nothing else
        // stops the cascade from deleting the Owner row with the Store.
        expect((await client.query(`DELETE FROM stores WHERE id = $1`, [storeId])).rowCount).toBe(1);
        const left = await client.query(`SELECT 1 FROM memberships WHERE store_id = $1`, [storeId]);
        expect(left.rowCount).toBe(0);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
      expect(await membershipsOf(storeId)).toEqual(before);
      const { rows } = await pool.query<{ tgenabled: string }>(
        `SELECT tgenabled FROM pg_trigger
         WHERE tgrelid = 'memberships'::regclass AND tgname = 'memberships_no_delete_owner'`,
      );
      expect(rows).toEqual([{ tgenabled: "O" }]);
    });
  });

  /**
   * The check must count the Owner rows of the real Store, whatever the
   * committing session's search_path or row-level security would show it:
   * a check that cannot see the Store skips it, and one that counts some
   * other table's rows can be satisfied by them.
   */
  describe("the check reads memberships' own tables, whatever the session sees", () => {
    const DECOY = `owner_invariant_decoy_${randomUUID().replace(/-/g, "")}`;

    beforeAll(async () => {
      await pool.query(`
        CREATE SCHEMA "${DECOY}";
        CREATE TABLE "${DECOY}".stores (id uuid);
        CREATE TABLE "${DECOY}".memberships (store_id uuid, role text)`);
    });

    afterAll(async () => {
      await pool?.query(`DROP SCHEMA IF EXISTS "${DECOY}" CASCADE`);
    });

    it("a temporary table named stores does not hide the Store", async () => {
      const { storeId } = await newStore();
      const before = await membershipsOf(storeId);

      // pg_temp comes before public in a session's search_path unless the
      // path lists it, so an unqualified `stores` would find this empty table.
      const { commitError } = await transaction([
        [`CREATE TEMP TABLE stores (id uuid) ON COMMIT DROP`],
        demoteOwner(storeId),
      ]);

      expect(commitError).toMatchObject(ownerRefusal(storeId));
      expect(await membershipsOf(storeId)).toEqual(before);
    });

    it("another schema's stores and memberships, first on the search_path, do not stand in for them", async () => {
      const { storeId } = await newStore();
      const before = await membershipsOf(storeId);

      // The decoy has the Store, and an Owner row for it.
      const { rowCounts, commitError } = await transaction([
        [`SET LOCAL search_path = "${DECOY}", public`],
        [`INSERT INTO "${DECOY}".stores (id) VALUES ($1)`, [storeId]],
        [`INSERT INTO "${DECOY}".memberships (store_id, role) VALUES ($1, 'owner')`, [storeId]],
        [`UPDATE public.memberships SET role = 'admin' WHERE store_id = $1 AND role = 'owner'`, [storeId]],
      ]);

      expect(rowCounts.slice(1)).toEqual([1, 1, 1]);
      expect(commitError).toMatchObject(ownerRefusal(storeId));
      expect(await membershipsOf(storeId)).toEqual(before);
    });

    it("a Store that row-level security hides from the session is an error, not a skipped check", async () => {
      const { storeId } = await newStore();
      const before = await membershipsOf(storeId);
      const forced = async () =>
        (
          await pool.query<{ relforcerowsecurity: boolean }>(
            `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'stores'::regclass`,
          )
        ).rows[0]!.relforcerowsecurity;

      try {
        // FORCE makes RLS apply to cloud_admin, the owner of stores, and no
        // policy grants it a row: the Store is invisible at COMMIT.
        const { commitError } = await transaction([
          [`ALTER TABLE stores FORCE ROW LEVEL SECURITY`],
          demoteOwner(storeId),
        ]);

        expect(commitError).toMatchObject({
          code: "42501",
          message: 'query would be affected by row-level security policy for table "stores"',
        });
        expect(await forced()).toBe(false);
      } finally {
        // Only a check that skipped the hidden Store lets that ALTER commit.
        if (await forced()) await pool.query(`ALTER TABLE stores NO FORCE ROW LEVEL SECURITY`);
      }
      expect(await membershipsOf(storeId)).toEqual(before);
    });
  });

  /**
   * Two real connections changing the same Store's Owner at once, under
   * READ COMMITTED (the default). Session B's statement is sent while
   * session A holds its locks, and the test waits until the server reports
   * B as waiting on a lock before A commits, so the interleaving is the one
   * named, not a race the test might lose.
   */
  describe("concurrent sessions", () => {
    /**
     * A connection of its own, outside the pool: ending it (in `finally`)
     * rolls back whatever it left open, even when an assertion failed
     * mid-transaction.
     */
    async function session(): Promise<{ client: Client; pid: number }> {
      const client = new Client({ connectionString: PLATFORM_URL });
      await client.connect();
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      return { client, pid: rows[0]!.pid };
    }

    /** Resolves once the backend `pid` is waiting on a lock (never for a later statement). */
    async function blockedOnLock(pid: number): Promise<void> {
      for (let attempt = 0; attempt < 500; attempt++) {
        const { rows } = await pool.query<{ wait_event_type: string | null }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        if (rows[0]?.wait_event_type === "Lock") return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`backend ${pid} never waited on a lock`);
    }

    /** The outcome of a query without rejecting: its row count, or its error. */
    function settle(promise: Promise<{ rowCount: number | null }>) {
      return promise.then(
        (result) => ({ rowCount: result.rowCount, error: null as unknown }),
        (error: unknown) => ({ rowCount: null, error }),
      );
    }

    it("B demotes the member A is promoting: B waits for A's row lock, then B's COMMIT is refused", async () => {
      const { storeId, owner, admin } = await newStore();
      const a = await session();
      const b = await session();
      try {
        await a.client.query("BEGIN");
        await a.client.query(...demoteOwner(storeId));
        await a.client.query(...promote(storeId, admin));

        await b.client.query("BEGIN");
        const bDemotes = settle(
          b.client.query(`UPDATE memberships SET role = 'staff' WHERE store_id = $1 AND user_id = $2`, [
            storeId,
            admin,
          ]),
        );
        await blockedOnLock(b.pid);

        await a.client.query("COMMIT");
        // B's UPDATE now finds the row A committed, an Owner row, and demotes it...
        expect(await bDemotes).toEqual({ rowCount: 1, error: null });
        // ...which leaves the Store with no Owner at B's COMMIT.
        await expect(b.client.query("COMMIT")).rejects.toMatchObject(ownerRefusal(storeId));
      } finally {
        await a.client.end();
        await b.client.end();
      }
      expect(await ownersOf(storeId)).toEqual([admin]);
      expect(await roleOf(owner, storeId)).toBe("admin");
    });

    it("A demotes the Owner while B promotes a member: B waits on the unique index, A's COMMIT is refused, then B is refused too", async () => {
      // Neither session can hand the Store to the other: the demotion and the
      // promotion must be one transaction, in that order.
      const { storeId, owner, staff } = await newStore();
      const before = await membershipsOf(storeId);
      const a = await session();
      const b = await session();
      try {
        await a.client.query("BEGIN");
        await a.client.query(...demoteOwner(storeId));

        await b.client.query("BEGIN");
        const bPromotes = settle(b.client.query(...promote(storeId, staff)));
        await blockedOnLock(b.pid);

        await expect(a.client.query("COMMIT")).rejects.toMatchObject(ownerRefusal(storeId));
        const promoted = await bPromotes;
        expect(promoted.error).toMatchObject({
          code: "23505",
          constraint: "memberships_one_owner_per_store",
        });
        await b.client.query("ROLLBACK");
      } finally {
        await a.client.end();
        await b.client.end();
      }
      expect(await membershipsOf(storeId)).toEqual(before);
      expect(await ownersOf(storeId)).toEqual([owner]);
    });

    it("two transfers at once: the second waits on the Owner row, then finds no Owner row to demote and cannot promote", async () => {
      const { storeId, owner, admin, staff } = await newStore();
      const a = await session();
      const b = await session();
      try {
        await a.client.query("BEGIN");
        await a.client.query(...demoteOwner(storeId));
        await a.client.query(...promote(storeId, admin));

        await b.client.query("BEGIN");
        const bDemotes = settle(b.client.query(...demoteOwner(storeId, "staff")));
        await blockedOnLock(b.pid);

        await a.client.query("COMMIT");
        // Re-checked after A's commit, the row B waited on is no longer the
        // Owner row, and A's new Owner row was not in B's scan.
        expect(await bDemotes).toEqual({ rowCount: 0, error: null });
        await expect(b.client.query(...promote(storeId, staff))).rejects.toMatchObject({
          code: "23505",
          constraint: "memberships_one_owner_per_store",
        });
        await b.client.query("ROLLBACK");
      } finally {
        await a.client.end();
        await b.client.end();
      }
      expect(await ownersOf(storeId)).toEqual([admin]);
      expect(await roleOf(owner, storeId)).toBe("admin");
      expect(await roleOf(staff, storeId)).toBe("staff");
    });
  });
});

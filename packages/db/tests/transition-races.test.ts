import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";

import {
  addCustomDomain,
  applyDomainVerification,
  applySchema,
  applyStoreStatusAction,
  closePools,
  provisionStore,
  resolveStoreByCustomDomain,
} from "../src/index";

/**
 * A Store's status and a Custom Domain's verification status only move along
 * their state machines (store-status.ts, domain-verification.ts), also when
 * two changes arrive at once.
 *
 * applyStoreStatusAction and applyDomainVerification read the current status,
 * ask the state machine, and write the result. They read without a lock, so
 * two concurrent changes could both be checked against the same old status,
 * and the later write won: a terminated Store could become active again, and
 * an active Store could be terminated without being suspended. Once the DNS
 * verification job (#58) sends DNS results (today only the dashboard's retry
 * does), a domain whose DNS had just failed could have been served again.
 * Now each one locks the row (SELECT ... FOR NO KEY UPDATE) before it reads
 * the status, so the second change waits for the first one and is checked
 * against its result.
 *
 * The competing change is a transaction of the test's own, opened on a
 * separate connection: it changes the row and holds the row lock. The call
 * under test is started, and the test waits until the server reports the
 * call's statement on that table waiting on that transaction's lock before
 * the competing transaction commits (or rolls back). A call that finishes
 * without waiting fails the test. Like every suite here, this assumes it is
 * the only run on its database.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";

describe("concurrent status changes follow the state machines", () => {
  let pool: Pool;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: PLATFORM_URL });
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  /** A new Store, with a new Owner, in the given status. */
  async function newStore(status: "active" | "suspended" | "terminated"): Promise<string> {
    const ownerId = `owner-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [
      ownerId,
      `${ownerId}@transition-races.test`,
    ]);
    const { store } = await provisionStore({
      name: "Race",
      subdomain: `race-${randomUUID().slice(0, 8)}`,
      ownerId,
    });
    await pool.query(`UPDATE stores SET status = $1 WHERE id = $2`, [status, store.id]);
    return store.id;
  }

  async function storeStatus(storeId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM stores WHERE id = $1`, [storeId]);
    return rows[0]!.status;
  }

  /** A new Custom Domain of a new Store, in the given verification status. */
  async function newDomain(
    status: "pending" | "verified" | "failed",
  ): Promise<{ storeId: string; domainId: string; hostname: string }> {
    const storeId = await newStore("active");
    const hostname = `race-${randomUUID().slice(0, 8)}.example.com`;
    const { id: domainId } = await addCustomDomain(storeId, hostname);
    await pool.query(`UPDATE custom_domains SET verification_status = $1 WHERE id = $2`, [status, domainId]);
    return { storeId, domainId, hostname };
  }

  async function domainRow(domainId: string) {
    const { rows } = await pool.query<{ verification_status: string; last_verified_at: Date | null }>(
      `SELECT verification_status, last_verified_at FROM custom_domains WHERE id = $1`,
      [domainId],
    );
    return rows[0]!;
  }

  /**
   * Runs `competing` in a transaction of its own that stays open, starts
   * `call`, waits until a statement of the call on `table` is waiting on
   * that transaction's locks, then ends the transaction with `end`. Returns
   * what `call` resolved to. A call that settles without waiting fails.
   *
   * The connection is ended in `finally`, which rolls back whatever it left
   * open, even when an assertion failed mid-transaction.
   */
  async function whileHeld<T>(
    table: "stores" | "custom_domains",
    competing: [text: string, values: unknown[]],
    end: "COMMIT" | "ROLLBACK",
    call: () => Promise<T>,
  ): Promise<T> {
    const gate = new Client({ connectionString: PLATFORM_URL });
    await gate.connect();
    try {
      const { rows } = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const gatePid = rows[0]!.pid;
      await gate.query("BEGIN");
      const changed = await gate.query(...competing);
      expect(changed.rowCount).toBe(1);

      let settled = false;
      const pending = call().finally(() => {
        settled = true;
      });
      // Keeps an early rejection from being reported as unhandled while the
      // test is still waiting; it is still awaited (and thrown) below.
      pending.catch(() => undefined);

      await blockedBy(gatePid, table, () => settled);
      if (settled) {
        await pending;
        throw new Error("the call finished without waiting for the competing transaction");
      }
      await gate.query(end);
      return await pending;
    } finally {
      await gate.end();
    }
  }

  /**
   * Resolves once a SELECT or UPDATE on `table` in this database is waiting
   * on a lock held by `pid`, or once `done()` says there is nothing left to
   * wait for.
   */
  async function blockedBy(pid: number, table: string, done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))
           AND query ~* ('^\\s*(select|update)\\M.*\\m' || $2 || '\\M')`,
        [pid, table],
      );
      if (rows.length > 0 || done()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no backend ever waited on a lock held by ${pid}`);
  }

  describe("Store status (applyStoreStatusAction)", () => {
    it("reinstating a Store that another transaction is terminating is refused: terminated stays terminal", async () => {
      const storeId = await newStore("suspended");

      const result = await whileHeld(
        "stores",
        [`UPDATE stores SET status = 'terminated' WHERE id = $1`, [storeId]],
        "COMMIT",
        () => applyStoreStatusAction(storeId, "reinstate"),
      );

      expect(result).toEqual({ ok: false, reason: "invalid_transition" });
      expect(await storeStatus(storeId)).toBe("terminated");
    });

    it("terminating a Store that another transaction is reinstating is refused: it is not terminated straight from active", async () => {
      const storeId = await newStore("suspended");

      const result = await whileHeld(
        "stores",
        [`UPDATE stores SET status = 'active' WHERE id = $1`, [storeId]],
        "COMMIT",
        () => applyStoreStatusAction(storeId, "terminate"),
      );

      expect(result).toEqual({ ok: false, reason: "invalid_transition" });
      expect(await storeStatus(storeId)).toBe("active");
    });

    it("suspending a Store that another transaction is suspending is refused (it is no longer active)", async () => {
      const storeId = await newStore("active");

      const result = await whileHeld(
        "stores",
        [`UPDATE stores SET status = 'suspended' WHERE id = $1`, [storeId]],
        "COMMIT",
        () => applyStoreStatusAction(storeId, "suspend"),
      );

      expect(result).toEqual({ ok: false, reason: "invalid_transition" });
      expect(await storeStatus(storeId)).toBe("suspended");
    });

    it("when the other transaction rolls back, the change waits for it and is checked against the status it left", async () => {
      const storeId = await newStore("suspended");

      const result = await whileHeld(
        "stores",
        [`UPDATE stores SET status = 'terminated' WHERE id = $1`, [storeId]],
        "ROLLBACK",
        () => applyStoreStatusAction(storeId, "reinstate"),
      );

      expect(result).toEqual({ ok: true });
      expect(await storeStatus(storeId)).toBe("active");
    });

    it("two real concurrent changes of a suspended Store: exactly one succeeds, and the status is the one it set", async () => {
      for (let round = 0; round < 10; round++) {
        const storeId = await newStore("suspended");
        const [reinstate, terminate] = await Promise.all([
          applyStoreStatusAction(storeId, "reinstate"),
          applyStoreStatusAction(storeId, "terminate"),
        ]);

        const succeeded = [reinstate.ok && "active", terminate.ok && "terminated"].filter(Boolean);
        expect(succeeded).toHaveLength(1);
        expect(await storeStatus(storeId)).toBe(succeeded[0]);
      }
    });

    it("an unknown Store still throws", async () => {
      await expect(applyStoreStatusAction(randomUUID(), "suspend")).rejects.toThrow(/not found/);
    });
  });

  describe("Custom Domain verification (applyDomainVerification)", () => {
    it("a DNS success on a domain whose DNS check is failing it is refused: the failed domain is not served again", async () => {
      const { storeId, domainId, hostname } = await newDomain("verified");
      const before = await domainRow(domainId);

      const result = await whileHeld(
        "custom_domains",
        [`UPDATE custom_domains SET verification_status = 'failed' WHERE id = $1`, [domainId]],
        "COMMIT",
        () => applyDomainVerification(storeId, domainId, "dns_ok"),
      );

      expect(result).toEqual({ ok: false, reason: "invalid_transition" });
      expect(await domainRow(domainId)).toEqual({
        verification_status: "failed",
        last_verified_at: before.last_verified_at,
      });
      expect(await resolveStoreByCustomDomain(hostname)).toBeNull();
    });

    it("a DNS success on a pending domain that another transaction fails is refused: failed needs a retry first", async () => {
      const { storeId, domainId, hostname } = await newDomain("pending");

      const result = await whileHeld(
        "custom_domains",
        [`UPDATE custom_domains SET verification_status = 'failed' WHERE id = $1`, [domainId]],
        "COMMIT",
        () => applyDomainVerification(storeId, domainId, "dns_ok"),
      );

      expect(result).toEqual({ ok: false, reason: "invalid_transition" });
      expect(await domainRow(domainId)).toEqual({ verification_status: "failed", last_verified_at: null });
      expect(await resolveStoreByCustomDomain(hostname)).toBeNull();
    });

    it("a retry of a domain that another transaction is already retrying is refused (it is pending now)", async () => {
      const { storeId, domainId } = await newDomain("failed");

      const result = await whileHeld(
        "custom_domains",
        [`UPDATE custom_domains SET verification_status = 'pending' WHERE id = $1`, [domainId]],
        "COMMIT",
        () => applyDomainVerification(storeId, domainId, "retry"),
      );

      expect(result).toEqual({ ok: false, reason: "invalid_transition" });
      expect((await domainRow(domainId)).verification_status).toBe("pending");
    });

    it("when the other transaction rolls back, the change waits for it and is checked against the status it left", async () => {
      const { storeId, domainId, hostname } = await newDomain("verified");

      const result = await whileHeld(
        "custom_domains",
        [`UPDATE custom_domains SET verification_status = 'failed' WHERE id = $1`, [domainId]],
        "ROLLBACK",
        () => applyDomainVerification(storeId, domainId, "dns_ok"),
      );

      expect(result).toEqual({ ok: true, status: "verified" });
      expect((await domainRow(domainId)).verification_status).toBe("verified");
      expect(await resolveStoreByCustomDomain(hostname)).toBe(storeId);
    });

    it("two real concurrent DNS results for a pending domain: the failure always stands", async () => {
      for (let round = 0; round < 10; round++) {
        const { storeId, domainId } = await newDomain("pending");
        const [ok, fail] = await Promise.all([
          applyDomainVerification(storeId, domainId, "dns_ok"),
          applyDomainVerification(storeId, domainId, "dns_fail"),
        ]);

        // Whichever runs first, the domain ends failed: pending → verified →
        // failed when the success runs first, and pending → failed (the
        // success then refused) when the failure does. Never failed → verified.
        expect(fail).toEqual({ ok: true, status: "failed" });
        expect([{ ok: true, status: "verified" }, { ok: false, reason: "invalid_transition" }]).toContainEqual(ok);
        expect((await domainRow(domainId)).verification_status).toBe("failed");
      }
    });

    it("a domain of another Store is still not found, and is left unchanged", async () => {
      const { domainId } = await newDomain("failed");
      const otherStore = await newStore("active");

      expect(await applyDomainVerification(otherStore, domainId, "retry")).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect((await domainRow(domainId)).verification_status).toBe("failed");
    });
  });
});

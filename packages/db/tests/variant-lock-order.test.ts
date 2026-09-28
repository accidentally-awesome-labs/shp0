import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";

import { applySchema, closePools, deleteProduct, markOrderPaid, provisionStore } from "../src/index";

/**
 * Variants are locked in id order wherever a transaction locks more than one
 * (ADR-0002's payment fence, and deleting a Product), so two such
 * transactions can make each other wait but never deadlock.
 *
 * markOrderPaid locked each Variant of an Order in the order its lines came
 * back, which is the order the shopper filled the Cart. Two Orders for the
 * same two Variants, filled in opposite orders and paid at once, each locked
 * one Variant and waited for the other: Postgres aborted one payment (40P01),
 * the webhook answered 500, and the paid Order stayed pending until Stripe
 * retried. Deleting a Product locked its Variants in storage order (the
 * ON DELETE CASCADE), with the same risk against a payment. Now both lock in
 * id order; markOrderPaid checks each Variant against the total of its
 * lines, and a payment that still loses a deadlock to some other
 * transaction is run again.
 *
 * In the gated tests the competing transactions are the test's own, on
 * separate connections, and the test waits until the server reports the call
 * under test waiting on their locks before it goes on, so the interleaving is
 * the one named. The tests with two real calls at once (Promise.allSettled)
 * check the end result only. Rows are set up directly in SQL, in the line
 * and storage order a test needs; that order is checked, and set up again
 * with new rows when Postgres stored them differently. Every id is new, so
 * the file shares the database with the other suites, one run at a time,
 * like them.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";

describe("Variants are locked in id order", () => {
  let pool: Pool;
  let storeId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: PLATFORM_URL });
    const ownerId = `owner-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [
      ownerId,
      `${ownerId}@variant-lock-order.test`,
    ]);
    const { store } = await provisionStore({
      name: "Locks",
      subdomain: `locks-${randomUUID().slice(0, 8)}`,
      ownerId,
    });
    storeId = store.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  /** Runs `fn` in a transaction of the Store (store_id is stamped from app.store_id). */
  async function asStore<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.store_id', $1, true)`, [storeId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Two new ids, `lo` < `hi` in uuid order: `lo` starts with 0, `hi` with f.
   */
  function idPair(): { lo: string; hi: string } {
    return { lo: `0${randomUUID().slice(1)}`, hi: `f${randomUUID().slice(1)}` };
  }

  /**
   * A published Product whose Variants are inserted in the order given, each
   * with `inventory` units. Returns the Product id.
   */
  async function newProduct(variantIds: string[], inventory = 10): Promise<string> {
    return asStore(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO products (title, slug, status) VALUES ('Locked', $1, 'published') RETURNING id`,
        [`locked-${randomUUID()}`],
      );
      const productId = rows[0]!.id;
      for (const [index, id] of variantIds.entries()) {
        await client.query(
          `INSERT INTO variants (id, product_id, sku, title, price_cents, inventory) VALUES ($1, $2, $3, 'V', 100, $4)`,
          [id, productId, `SKU-${index}-${id}`, inventory],
        );
      }
      return productId;
    });
  }

  /** A pending Order whose lines are inserted in the order given. */
  async function newOrder(lines: Array<{ variantId: string; quantity: number }>): Promise<string> {
    return asStore(async (client) => {
      const total = lines.reduce((sum, line) => sum + line.quantity * 100, 0);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2) RETURNING id`,
        [`customer-${randomUUID()}`, total],
      );
      const orderId = rows[0]!.id;
      for (const line of lines) {
        await client.query(
          `INSERT INTO order_lines (order_id, variant_id, quantity, unit_price_cents) VALUES ($1, $2, $3, 100)`,
          [orderId, line.variantId, line.quantity],
        );
      }
      return orderId;
    });
  }

  /** The order the lines come back in without ORDER BY (the old read). */
  async function lineReadOrder(orderId: string): Promise<string[]> {
    const { rows } = await pool.query<{ variant_id: string }>(
      `SELECT variant_id FROM order_lines WHERE order_id = $1`,
      [orderId],
    );
    return rows.map((row) => row.variant_id);
  }

  /** The order the Variants come back in without ORDER BY (the cascade's order). */
  async function variantReadOrder(productId: string): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM variants WHERE product_id = $1`, [productId]);
    return rows.map((row) => row.id);
  }

  /**
   * A Product with two Variants stored hi first (the order a scan without
   * ORDER BY returns, which is the cascade's order), where lo < hi in id
   * order. Rows are usually stored in insertion order, but not always: an
   * insert can land on an earlier page that has free space. So the order is
   * checked, and a Product stored otherwise is deleted and made again with
   * new ids.
   */
  async function productStoredHiFirst(): Promise<{ productId: string; lo: string; hi: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { lo, hi } = idPair();
      const productId = await newProduct([hi, lo]);
      if ((await variantReadOrder(productId)).join() === [hi, lo].join()) return { productId, lo, hi };
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
    }
    throw new Error("could not store two Variants hi first in 5 attempts");
  }

  /**
   * A pending Order whose lines are stored in the order given (the order a
   * scan without ORDER BY returns). Checked, and made again otherwise, as in
   * productStoredHiFirst.
   */
  async function orderStoredAs(lines: Array<{ variantId: string; quantity: number }>): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderId = await newOrder(lines);
      if ((await lineReadOrder(orderId)).join() === lines.map((line) => line.variantId).join()) return orderId;
      await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
    }
    throw new Error("could not store the Order's lines in the order given in 5 attempts");
  }

  async function inventoryOf(variantId: string): Promise<number | undefined> {
    const { rows } = await pool.query<{ inventory: number }>(`SELECT inventory FROM variants WHERE id = $1`, [
      variantId,
    ]);
    return rows[0]?.inventory;
  }

  async function paymentStatusOf(orderId: string): Promise<string> {
    const { rows } = await pool.query<{ payment_status: string }>(
      `SELECT payment_status FROM orders WHERE id = $1`,
      [orderId],
    );
    return rows[0]!.payment_status;
  }

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

  /**
   * Resolves once a backend of the tenant role ("default", which
   * markOrderPaid and deleteProduct run as) is waiting on a lock held by
   * `pid`. Throws if `settled()` says the call under test finished without
   * waiting. (The query text of another role's backend is hidden from this
   * role, so the role is what identifies the call.)
   */
  async function blockedBy(pid: number, settled: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'default'
           AND $1 = ANY (pg_blocking_pids(pid))`,
        [pid],
      );
      if (rows.length > 0) return;
      if (settled()) throw new Error(`the call finished without waiting for backend ${pid}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no statement ever waited on a lock held by ${pid}`);
  }

  /** Starts `call`, tracking whether it has settled; its rejection is awaited later. */
  function start<T>(call: () => Promise<T>): { promise: Promise<T>; settled: () => boolean } {
    let done = false;
    const promise = call().finally(() => {
      done = true;
    });
    promise.catch(() => undefined);
    return { promise, settled: () => done };
  }

  /** Whether another transaction could lock `variantId` right now (FOR UPDATE NOWAIT). */
  async function lockable(variantId: string): Promise<boolean> {
    const probe = await session();
    try {
      await probe.client.query("BEGIN");
      await probe.client.query(`SELECT 1 FROM variants WHERE id = $1 FOR UPDATE NOWAIT`, [variantId]);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "55P03") return false; // lock_not_available
      throw error;
    } finally {
      await probe.client.end();
    }
  }

  describe("markOrderPaid", () => {
    it("locks an Order's Variants in id order, not in line order: waiting for the lower id, it holds no other", async () => {
      // Line order and storage order both put hi first; only id order puts
      // lo first.
      const { lo, hi } = await productStoredHiFirst();
      const orderId = await orderStoredAs([
        { variantId: hi, quantity: 1 },
        { variantId: lo, quantity: 1 },
      ]);

      const gate = await session();
      try {
        await gate.client.query("BEGIN");
        await gate.client.query(`SELECT 1 FROM variants WHERE id = $1 FOR UPDATE`, [lo]);

        const payment = start(() => markOrderPaid(storeId, orderId));
        await blockedBy(gate.pid, payment.settled);

        // In line order (or in storage order) the payment would hold hi
        // while it waits for lo.
        expect(await lockable(hi)).toBe(true);

        await gate.client.query("COMMIT");
        expect(await payment.promise).toEqual({ ok: true });
      } finally {
        await gate.client.end();
      }
      expect(await inventoryOf(lo)).toBe(9);
      expect(await inventoryOf(hi)).toBe(9);
      expect(await paymentStatusOf(orderId)).toBe("paid");
    });

    it("two Orders for the same Variants in opposite line order, paid at once, are both paid", async () => {
      for (let round = 0; round < 10; round++) {
        const { lo, hi } = idPair();
        await newProduct([lo, hi]);
        const first = await newOrder([
          { variantId: lo, quantity: 1 },
          { variantId: hi, quantity: 2 },
        ]);
        const second = await newOrder([
          { variantId: hi, quantity: 3 },
          { variantId: lo, quantity: 4 },
        ]);

        const results = await Promise.allSettled([markOrderPaid(storeId, first), markOrderPaid(storeId, second)]);

        expect(results).toEqual([
          { status: "fulfilled", value: { ok: true } },
          { status: "fulfilled", value: { ok: true } },
        ]);
        expect(await inventoryOf(lo)).toBe(10 - 1 - 4);
        expect(await inventoryOf(hi)).toBe(10 - 2 - 3);
      }
    });

    it("a payment that loses a deadlock to another transaction is run again, and succeeds once it ends", async () => {
      // Postgres checks a waiter for a deadlock once, deadlock_timeout (1s)
      // after it starts waiting, and aborts the waiter whose check finds the
      // cycle. The payment starts waiting first, so it is the one aborted,
      // provided the other transaction starts waiting within that second. On
      // a runner stalled for longer the other transaction is aborted instead,
      // the payment's retry is never needed, and the scenario runs again.
      for (let run = 0; run < 3; run++) {
        const { lo, hi } = idPair();
        await newProduct([lo, hi]);
        // In line order, as in id order, the payment locks lo first (so the
        // unfixed markOrderPaid deadlocks here too).
        const orderId = await orderStoredAs([
          { variantId: lo, quantity: 1 },
          { variantId: hi, quantity: 1 },
        ]);

        const gate = await session();
        try {
          await gate.client.query("BEGIN");
          await gate.client.query(`SELECT 1 FROM variants WHERE id = $1 FOR UPDATE`, [hi]);

          // The payment locks lo, then waits for hi.
          const payment = start(() => markOrderPaid(storeId, orderId));
          await blockedBy(gate.pid, payment.settled);

          // The other transaction now waits for lo: a deadlock. Once the
          // payment is aborted (40P01), lo is released and this lock is
          // granted.
          try {
            await gate.client.query(`SELECT 1 FROM variants WHERE id = $1 FOR UPDATE`, [lo]);
          } catch (error) {
            if ((error as { code?: string }).code !== "40P01") throw error;
            // This transaction was aborted instead; the payment then went on.
            await gate.client.query("ROLLBACK");
            expect(await payment.promise).toEqual({ ok: true });
            continue;
          }
          // The payment's retry now waits for lo.
          expect(payment.settled()).toBe(false);

          await gate.client.query("COMMIT");
          expect(await payment.promise).toEqual({ ok: true });
        } finally {
          await gate.client.end();
        }
        expect(await inventoryOf(lo)).toBe(9);
        expect(await inventoryOf(hi)).toBe(9);
        expect(await paymentStatusOf(orderId)).toBe("paid");
        return;
      }
      throw new Error("the other transaction was chosen as the deadlock victim in every run");
    }, 30000);

    it("checks a Variant on two lines against the total of both (no oversell)", async () => {
      const variant = randomUUID();
      await newProduct([variant], 5);
      const orderId = await newOrder([
        { variantId: variant, quantity: 3 },
        { variantId: variant, quantity: 3 },
      ]);

      expect(await markOrderPaid(storeId, orderId)).toEqual({ ok: false, reason: "insufficient_inventory" });
      expect(await inventoryOf(variant)).toBe(5);
      expect(await paymentStatusOf(orderId)).toBe("pending");
    });

    it("decrements a Variant on two lines by the total of both", async () => {
      const variant = randomUUID();
      await newProduct([variant], 7);
      const orderId = await newOrder([
        { variantId: variant, quantity: 3 },
        { variantId: variant, quantity: 4 },
      ]);

      expect(await markOrderPaid(storeId, orderId)).toEqual({ ok: true });
      expect(await inventoryOf(variant)).toBe(0);
    });

    it("still refuses an Order whose Variant no longer exists, and changes nothing", async () => {
      const { lo, hi } = idPair();
      await newProduct([lo]);
      const orderId = await newOrder([
        { variantId: lo, quantity: 1 },
        { variantId: hi, quantity: 1 },
      ]);

      await expect(markOrderPaid(storeId, orderId)).rejects.toThrow(`Variant ${hi} not found`);
      expect(await inventoryOf(lo)).toBe(10);
      expect(await paymentStatusOf(orderId)).toBe("pending");
    });

    it("still pays an Order with no lines, and a second call is already_paid", async () => {
      const orderId = await newOrder([]);
      expect(await markOrderPaid(storeId, orderId)).toEqual({ ok: true });
      expect(await markOrderPaid(storeId, orderId)).toEqual({ ok: false, reason: "already_paid" });
    });
  });

  describe("deleteProduct", () => {
    it("locks the Product's Variants in id order before deleting: waiting for the lower id, it holds no other", async () => {
      const { productId, lo, hi } = await productStoredHiFirst();

      const gate = await session();
      try {
        await gate.client.query("BEGIN");
        await gate.client.query(`SELECT 1 FROM variants WHERE id = $1 FOR UPDATE`, [lo]);

        const deletion = start(() => deleteProduct(storeId, productId));
        await blockedBy(gate.pid, deletion.settled);

        // In storage order (the cascade) the delete would hold hi while it
        // waits for lo.
        expect(await lockable(hi)).toBe(true);

        await gate.client.query("COMMIT");
        await deletion.promise;
      } finally {
        await gate.client.end();
      }
      expect(await inventoryOf(lo)).toBeUndefined();
      expect(await inventoryOf(hi)).toBeUndefined();
    });

    it("a payment and the deletion of its Product, at once, both complete", async () => {
      for (let round = 0; round < 10; round++) {
        const { lo, hi } = idPair();
        const productId = await newProduct([hi, lo]);
        const orderId = await newOrder([
          { variantId: lo, quantity: 1 },
          { variantId: hi, quantity: 1 },
        ]);

        const [payment, deletion] = await Promise.allSettled([
          markOrderPaid(storeId, orderId),
          deleteProduct(storeId, productId),
        ]);

        expect(deletion).toEqual({ status: "fulfilled", value: undefined });
        // Paid first, then deleted; or deleted first, and the payment finds
        // its Variants gone (unchanged behaviour, not a deadlock).
        if (payment.status === "fulfilled") {
          expect(payment.value).toEqual({ ok: true });
        } else {
          expect(String(payment.reason)).toMatch(/^Error: Variant [0-9a-f-]+ not found$/);
        }
      }
    });
  });
});

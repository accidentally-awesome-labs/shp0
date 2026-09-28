import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { applySchema, closePools, provisionStore, upsertPaymentAccount } from "@shp0/db";

import { handleStripeWebhook } from "../src/index";
import { startFakeStripe, stripeError, type FakeStripe } from "./fake-stripe";

/**
 * The Stripe webhook takes only real payments that match shp0's own Orders,
 * and refunds, in full, the ones it cannot honour (ADR-0006).
 *
 * Every event below is signed with the endpoint secret, as Stripe signs it,
 * and arrives the way a direct charge's events do: on the Connect endpoint,
 * with `account` set to the Store's Stripe account. The Stripe API is a local
 * fake that records each request (tests/fake-stripe.ts). Database effects are
 * read back from Postgres.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";
const SECRET = "whsec_test_secret";

describe("Stripe webhook (ADR-0006)", () => {
  let pool: Pool;
  let fake: FakeStripe;
  let storeId: string;
  let otherStoreId: string;
  let account: string;
  let otherAccount: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: PLATFORM_URL });
    fake = await startFakeStripe();
    storeId = await newStore("webhook");
    otherStoreId = await newStore("webhook-other");
    account = `acct_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    otherAccount = `acct_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await upsertPaymentAccount({ storeId, connectAccountId: account, detailsSubmitted: true, chargesEnabled: true });
    await upsertPaymentAccount({
      storeId: otherStoreId,
      connectAccountId: otherAccount,
      detailsSubmitted: true,
      chargesEnabled: true,
    });
  });

  afterAll(async () => {
    await fake.close();
    await pool.end();
    await closePools();
  });

  beforeEach(() => {
    fake.requests.length = 0;
  });

  async function newStore(label: string): Promise<string> {
    const ownerId = `owner-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [
      ownerId,
      `${ownerId}@webhook.test`,
    ]);
    const { store } = await provisionStore({
      name: label,
      subdomain: `${label}-${randomUUID().slice(0, 8)}`,
      ownerId,
    });
    return store.id;
  }

  /** Runs `fn` in a transaction of `store` (store_id is stamped from app.store_id). */
  async function asStore<T>(store: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.store_id', $1, true)`, [store]);
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
   * A pending Order of `store` for `quantity` units of a new Variant with
   * `inventory` in stock, priced 1500 each. Returns the Order and Variant ids
   * and the Order total.
   */
  async function newOrder(
    { store = storeId, inventory = 10, quantity = 2 }: { store?: string; inventory?: number; quantity?: number } = {},
  ): Promise<{ orderId: string; variantId: string; total: number }> {
    return asStore(store, async (client) => {
      const { rows: products } = await client.query<{ id: string }>(
        `INSERT INTO products (title, slug, status) VALUES ('Mug', $1, 'published') RETURNING id`,
        [`mug-${randomUUID()}`],
      );
      const { rows: variants } = await client.query<{ id: string }>(
        `INSERT INTO variants (product_id, sku, title, price_cents, inventory) VALUES ($1, $2, 'Mug', 1500, $3) RETURNING id`,
        [products[0]!.id, `MUG-${randomUUID()}`, inventory],
      );
      const total = 1500 * quantity;
      const { rows: orders } = await client.query<{ id: string }>(
        `INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2) RETURNING id`,
        [randomUUID(), total],
      );
      await client.query(
        `INSERT INTO order_lines (order_id, variant_id, quantity, unit_price_cents) VALUES ($1, $2, $3, 1500)`,
        [orders[0]!.id, variants[0]!.id, quantity],
      );
      return { orderId: orders[0]!.id, variantId: variants[0]!.id, total };
    });
  }

  type SessionFields = {
    orderId?: string;
    store?: string;
    paymentIntent?: string;
    amount?: number;
    currency?: string;
    paymentStatus?: "paid" | "unpaid" | "no_payment_required";
    metadata?: Record<string, string>;
  };

  /** A Checkout Session as Stripe sends it in an event, with shp0's metadata. */
  function session(fields: SessionFields & { orderId: string; amount: number }) {
    const paymentIntent = fields.paymentIntent ?? `pi_${randomUUID().replaceAll("-", "")}`;
    return {
      id: `cs_test_${randomUUID().replaceAll("-", "")}`,
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: fields.paymentStatus ?? "paid",
      amount_total: fields.amount,
      currency: fields.currency ?? "usd",
      payment_intent: paymentIntent,
      metadata: fields.metadata ?? { shp0_store_id: fields.store ?? storeId, shp0_order_id: fields.orderId },
    };
  }

  type EventFields = {
    type?: string;
    account?: string | null;
    livemode?: boolean;
    id?: string;
  };

  /** A signed event, as Stripe delivers it to the Connect endpoint. */
  function event(object: Record<string, unknown>, fields: EventFields = {}) {
    const body: Record<string, unknown> = {
      id: fields.id ?? `evt_${randomUUID().replaceAll("-", "")}`,
      object: "event",
      api_version: "2026-06-24.dahlia",
      created: Math.floor(Date.now() / 1000),
      livemode: fields.livemode ?? false,
      type: fields.type ?? "checkout.session.completed",
      data: { object },
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
    };
    if (fields.account !== null) body.account = fields.account ?? account;
    const payload = JSON.stringify(body);
    const signature = fake.stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    return { payload, signature };
  }

  function deliver(signed: { payload: string; signature: string | null }) {
    return handleStripeWebhook(signed.payload, signed.signature, {
      stripe: fake.stripe,
      webhookSecret: SECRET,
      livemode: false,
    });
  }

  async function paymentStatusOf(orderId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ payment_status: string }>(`SELECT payment_status FROM orders WHERE id = $1`, [
      orderId,
    ]);
    return rows[0]?.payment_status;
  }

  async function inventoryOf(variantId: string): Promise<number | undefined> {
    const { rows } = await pool.query<{ inventory: number }>(`SELECT inventory FROM variants WHERE id = $1`, [
      variantId,
    ]);
    return rows[0]?.inventory;
  }

  async function paymentRow(paymentIntent: string) {
    const { rows } = await pool.query(
      `SELECT store_id, order_id, stripe_account_id, checkout_session_id, amount_cents::int AS amount_cents,
              currency, status, refund_reason, stripe_refund_id
         FROM payments WHERE payment_intent_id = $1`,
      [paymentIntent],
    );
    return rows[0];
  }

  function refundRequests() {
    return fake.requests.filter((request) => request.method === "POST" && request.path === "/v1/refunds");
  }

  describe("a matching, paid session pays its Order", () => {
    it("marks the Order paid, takes the stock and records the Payment; nothing is refunded", async () => {
      const { orderId, variantId, total } = await newOrder({ quantity: 2 });
      const completed = session({ orderId, amount: total });

      expect(await deliver(event(completed))).toMatchObject({ status: 200 });

      expect(await paymentStatusOf(orderId)).toBe("paid");
      expect(await inventoryOf(variantId)).toBe(8);
      expect(await paymentRow(completed.payment_intent)).toEqual({
        store_id: storeId,
        order_id: orderId,
        stripe_account_id: account,
        checkout_session_id: completed.id,
        amount_cents: total,
        currency: "usd",
        status: "paid",
        refund_reason: null,
        stripe_refund_id: null,
      });
      expect(fake.requests).toEqual([]);
    });

    it("a delayed payment method pays the Order only on async_payment_succeeded", async () => {
      const { orderId, variantId, total } = await newOrder();
      const unpaid = session({ orderId, amount: total, paymentStatus: "unpaid" });

      expect(await deliver(event(unpaid))).toMatchObject({ status: 200 });
      expect(await paymentStatusOf(orderId)).toBe("pending");
      expect(await inventoryOf(variantId)).toBe(10);

      const succeeded = { ...unpaid, payment_status: "paid" };
      expect(await deliver(event(succeeded, { type: "checkout.session.async_payment_succeeded" }))).toMatchObject({
        status: 200,
      });
      expect(await paymentStatusOf(orderId)).toBe("paid");
      expect(await inventoryOf(variantId)).toBe(8);
    });

    it("async_payment_failed leaves the Order pending and refunds nothing", async () => {
      const { orderId, total } = await newOrder();
      const failed = session({ orderId, amount: total, paymentStatus: "unpaid" });

      expect(await deliver(event(failed, { type: "checkout.session.async_payment_failed" }))).toMatchObject({
        status: 200,
      });
      expect(await paymentStatusOf(orderId)).toBe("pending");
      expect(await paymentRow(failed.payment_intent)).toBeUndefined();
      expect(refundRequests()).toEqual([]);
    });

    it("the same event delivered twice, or the same payment in two events, changes nothing the second time", async () => {
      const { orderId, variantId, total } = await newOrder();
      const completed = session({ orderId, amount: total });
      const signed = event(completed);

      expect(await deliver(signed)).toMatchObject({ status: 200 });
      expect(await deliver(signed)).toMatchObject({ status: 200 });
      expect(await deliver(event(completed, { type: "checkout.session.async_payment_succeeded" }))).toMatchObject({
        status: 200,
      });

      expect(await paymentStatusOf(orderId)).toBe("paid");
      expect(await inventoryOf(variantId)).toBe(8);
      expect(refundRequests()).toEqual([]);
    });

    it("the same payment delivered twice at once is taken once", async () => {
      const { orderId, variantId, total } = await newOrder();
      const completed = session({ orderId, amount: total });

      const results = await Promise.all([deliver(event(completed)), deliver(event(completed))]);

      expect(results.map((result) => result.status)).toEqual([200, 200]);
      expect(await paymentStatusOf(orderId)).toBe("paid");
      expect(await inventoryOf(variantId)).toBe(8);
      expect(refundRequests()).toEqual([]);
    });
  });

  describe("a payment shp0 cannot honour is refunded in full, on the Store's account", () => {
    function expectOneRefund(paymentIntent: string, reason: string) {
      expect(refundRequests()).toHaveLength(1);
      const [refund] = refundRequests();
      expect(refund!.stripeAccount).toBe(account);
      expect(refund!.idempotencyKey).toBe(`refund:${paymentIntent}`);
      expect(refund!.params.get("payment_intent")).toBe(paymentIntent);
      expect(refund!.params.has("amount")).toBe(false);
      expect(refund!.params.get("metadata[shp0_reason]")).toBe(reason);
    }

    it("stock ran out before the payment arrived: refunded, the Order stays pending, no stock is taken", async () => {
      const { orderId, variantId, total } = await newOrder({ inventory: 1, quantity: 2 });
      const completed = session({ orderId, amount: total });

      expect(await deliver(event(completed))).toMatchObject({ status: 200 });

      expect(await paymentStatusOf(orderId)).toBe("pending");
      expect(await inventoryOf(variantId)).toBe(1);
      expectOneRefund(completed.payment_intent, "insufficient_inventory");
      expect(await paymentRow(completed.payment_intent)).toMatchObject({
        order_id: orderId,
        status: "refunded",
        refund_reason: "insufficient_inventory",
        stripe_refund_id: "re_test_1",
      });
    });

    it("a Variant of the Order was deleted: refunded like stock that ran out, not retried forever", async () => {
      const { orderId, variantId, total } = await newOrder();
      await pool.query(`DELETE FROM variants WHERE id = $1`, [variantId]);
      const completed = session({ orderId, amount: total });

      expect(await deliver(event(completed))).toMatchObject({ status: 200 });

      expect(await paymentStatusOf(orderId)).toBe("pending");
      expectOneRefund(completed.payment_intent, "insufficient_inventory");
      expect(await paymentRow(completed.payment_intent)).toMatchObject({ status: "refunded" });
    });

    it("a second payment for an Order already paid: refunded, the first stands", async () => {
      const { orderId, variantId, total } = await newOrder();
      const first = session({ orderId, amount: total });
      const second = session({ orderId, amount: total });

      await deliver(event(first));
      expect(await deliver(event(second))).toMatchObject({ status: 200 });

      expect(await paymentStatusOf(orderId)).toBe("paid");
      expect(await inventoryOf(variantId)).toBe(8);
      expectOneRefund(second.payment_intent, "already_paid");
      expect(await paymentRow(first.payment_intent)).toMatchObject({ status: "paid" });
      expect(await paymentRow(second.payment_intent)).toMatchObject({ status: "refunded", refund_reason: "already_paid" });
    });

    it("two different payments for one Order at once: exactly one pays it, the other is refunded", async () => {
      const { orderId, variantId, total } = await newOrder();
      const first = session({ orderId, amount: total });
      const second = session({ orderId, amount: total });

      const results = await Promise.all([deliver(event(first)), deliver(event(second))]);

      expect(results.map((result) => result.status)).toEqual([200, 200]);
      expect(await paymentStatusOf(orderId)).toBe("paid");
      expect(await inventoryOf(variantId)).toBe(8);
      const statuses = [
        (await paymentRow(first.payment_intent))!.status,
        (await paymentRow(second.payment_intent))!.status,
      ].sort();
      expect(statuses).toEqual(["paid", "refunded"]);
      expect(refundRequests()).toHaveLength(1);
    });

    it.each([
      ["an amount other than the Order total", { amountDelta: -100, currency: "usd" }],
      ["a currency other than the Store's", { amountDelta: 0, currency: "eur" }],
    ])("%s: refunded, the Order stays pending", async (_label, { amountDelta, currency }) => {
      const { orderId, variantId, total } = await newOrder();
      const mismatched = session({ orderId, amount: total + amountDelta, currency });

      expect(await deliver(event(mismatched))).toMatchObject({ status: 200 });

      expect(await paymentStatusOf(orderId)).toBe("pending");
      expect(await inventoryOf(variantId)).toBe(10);
      expectOneRefund(mismatched.payment_intent, "mismatch");
    });

    it("an Order that is not in the Store: refunded, recorded without an Order", async () => {
      const completed = session({ orderId: randomUUID(), amount: 3000 });

      expect(await deliver(event(completed))).toMatchObject({ status: 200 });

      expectOneRefund(completed.payment_intent, "order_not_payable");
      expect(await paymentRow(completed.payment_intent)).toMatchObject({ order_id: null, status: "refunded" });
    });

    it.each(["cancelled", "voided"])("an Order that is %s: refunded, the Order is unchanged", async (status) => {
      const { orderId, variantId, total } = await newOrder();
      await pool.query(`UPDATE orders SET payment_status = $1 WHERE id = $2`, [status, orderId]);
      const completed = session({ orderId, amount: total });

      expect(await deliver(event(completed))).toMatchObject({ status: 200 });

      expect(await paymentStatusOf(orderId)).toBe(status);
      expect(await inventoryOf(variantId)).toBe(10);
      expectOneRefund(completed.payment_intent, "order_not_payable");
    });

    it("the refund request fails: 500, so Stripe delivers the event again, and the retry refunds once", async () => {
      const { orderId, total } = await newOrder({ inventory: 0 });
      const completed = session({ orderId, amount: total });
      const signed = event(completed);
      fake.reply(stripeError(500, "api_error"));

      expect(await deliver(signed)).toMatchObject({ status: 500 });
      expect(await paymentRow(completed.payment_intent)).toMatchObject({ status: "refunding" });

      expect(await deliver(signed)).toMatchObject({ status: 200 });
      expect(await paymentRow(completed.payment_intent)).toMatchObject({ status: "refunded" });
      expect(refundRequests().map((request) => request.idempotencyKey)).toEqual([
        `refund:${completed.payment_intent}`,
        `refund:${completed.payment_intent}`,
      ]);
    });

    it("Stripe answers that the charge is already refunded: counted as refunded", async () => {
      const { orderId, total } = await newOrder({ inventory: 0 });
      const completed = session({ orderId, amount: total });
      fake.reply(stripeError(400, "charge_already_refunded", "Charge has already been refunded."));

      expect(await deliver(event(completed))).toMatchObject({ status: 200 });
      expect(await paymentRow(completed.payment_intent)).toMatchObject({ status: "refunded", stripe_refund_id: null });
    });
  });

  describe("anything that is not shp0's is answered 200 and changes nothing", () => {
    async function expectIgnored(signed: { payload: string; signature: string }, orderId: string, variantId: string) {
      expect(await deliver(signed)).toMatchObject({ status: 200 });
      expect(await paymentStatusOf(orderId)).toBe("pending");
      expect(await inventoryOf(variantId)).toBe(10);
      expect(fake.requests).toEqual([]);
    }

    it("an event from the other mode (live event, test key)", async () => {
      const { orderId, variantId, total } = await newOrder();
      await expectIgnored(event(session({ orderId, amount: total }), { livemode: true }), orderId, variantId);
    });

    it("an event without a connected account (not a Connect event)", async () => {
      const { orderId, variantId, total } = await newOrder();
      await expectIgnored(event(session({ orderId, amount: total }), { account: null }), orderId, variantId);
    });

    it("an account that is no Store's", async () => {
      const { orderId, variantId, total } = await newOrder();
      await expectIgnored(event(session({ orderId, amount: total }), { account: "acct_unknown" }), orderId, variantId);
    });

    it("a session without shp0's metadata (another integration on the Merchant's account)", async () => {
      const { orderId, variantId, total } = await newOrder();
      await expectIgnored(event(session({ orderId, amount: total, metadata: { orderId } })), orderId, variantId);
    });

    it("a session whose shp0 order id is not a UUID", async () => {
      const { orderId, variantId, total } = await newOrder();
      const metadata = { shp0_store_id: storeId, shp0_order_id: "order-1" };
      await expectIgnored(event(session({ orderId, amount: total, metadata })), orderId, variantId);
    });

    it("a session naming another Store than the account's", async () => {
      const other = await newOrder({ store: otherStoreId });
      const completed = session({ orderId: other.orderId, amount: other.total, store: otherStoreId });
      await expectIgnored(event(completed), other.orderId, other.variantId);
    });

    it("an event type the endpoint does not handle", async () => {
      const { orderId, variantId, total } = await newOrder();
      await expectIgnored(
        event(session({ orderId, amount: total }), { type: "checkout.session.expired" }),
        orderId,
        variantId,
      );
    });
  });

  describe("signatures", () => {
    it("a bad signature is refused with 400 and changes nothing", async () => {
      const { orderId, total } = await newOrder();
      const signed = event(session({ orderId, amount: total }));

      expect(await deliver({ payload: signed.payload, signature: "t=1,v1=bad" })).toMatchObject({ status: 400 });
      expect(await deliver({ payload: signed.payload, signature: null })).toMatchObject({ status: 400 });
      expect(await paymentStatusOf(orderId)).toBe("pending");
    });
  });
});

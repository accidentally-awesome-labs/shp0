import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { applySchema, closePools, getStorefrontOrder, provisionStore, upsertPaymentAccount } from "@shp0/db";

import { getCheckoutAvailability, handleStripeWebhook, startCheckout, type CheckoutOutcome } from "../src/index";
import { startFakeStripe, stripeError, type FakeSession, type FakeStripe, type RecordedRequest } from "./fake-stripe";

/**
 * Pay: a Customer's pending Order gets one Checkout Session on the Store's own
 * Stripe account, and only an Order Stripe can charge gets one (ADR-0006).
 *
 * The Stripe API is a local fake that records each request and keeps the
 * sessions it created, which a test moves along (paid, expired, failed) the
 * way a Customer and Stripe would (tests/fake-stripe.ts). What shp0 recorded
 * on the Order is read back from Postgres.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";
const ORIGIN = "https://shop.example.test";

type Line = { title?: string; variantTitle?: string; price?: number; quantity?: number; inventory?: number; variantId?: string };

describe("Pay: starting Stripe Checkout for an Order (ADR-0006)", () => {
  let pool: Pool;
  let fake: FakeStripe;
  let storeId: string;
  let account: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: PLATFORM_URL });
    // Production's client keeps the SDK's default of 2 retries: Pay must turn
    // them off for its own requests (a retry could outlive the attempt).
    fake = await startFakeStripe({ clientRetries: 2 });
    storeId = await newStore("checkout");
    account = newAccountId();
    await upsertPaymentAccount({ storeId, connectAccountId: account, detailsSubmitted: true, chargesEnabled: true });
  });

  afterAll(async () => {
    await fake.close();
    await pool.end();
    await closePools();
  });

  beforeEach(() => {
    fake.reset();
  });

  function newAccountId(): string {
    return `acct_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  }

  async function newStore(label: string): Promise<string> {
    const ownerId = `owner-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [
      ownerId,
      `${ownerId}@checkout.test`,
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
   * An Order of `store`, placed with a new cart token. Each line is a new
   * Variant (price 1500 and 10 in stock unless given), or `variantId`'s.
   * The total is the lines' sum unless given.
   */
  async function newOrder({
    store = storeId,
    lines = [{}],
    total,
    paymentStatus = "pending",
  }: { store?: string; lines?: Line[]; total?: number; paymentStatus?: string } = {}): Promise<{
    orderId: string;
    token: string;
    variantIds: string[];
    total: number;
  }> {
    return asStore(store, async (client) => {
      const token = randomUUID();
      const variantIds: string[] = [];
      for (const line of lines) {
        if (line.variantId) {
          variantIds.push(line.variantId);
          continue;
        }
        const { rows: products } = await client.query<{ id: string }>(
          `INSERT INTO products (title, slug, status) VALUES ($1, $2, 'published') RETURNING id`,
          [line.title ?? "Mug", `p-${randomUUID()}`],
        );
        const { rows: variants } = await client.query<{ id: string }>(
          `INSERT INTO variants (product_id, sku, title, price_cents, inventory) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [products[0]!.id, `SKU-${randomUUID()}`, line.variantTitle ?? "Default", line.price ?? 1500, line.inventory ?? 10],
        );
        variantIds.push(variants[0]!.id);
      }
      const sum = lines.reduce((acc, line) => acc + (line.price ?? 1500) * (line.quantity ?? 1), 0);
      const orderTotal = total ?? sum;
      const { rows: orders } = await client.query<{ id: string }>(
        `INSERT INTO orders (customer_id, total_cents, payment_status) VALUES ($1, $2, $3) RETURNING id`,
        [token, orderTotal, paymentStatus],
      );
      const orderId = orders[0]!.id;
      for (const [i, line] of lines.entries()) {
        // Lines keep the order they were placed in (created_at, then id).
        await client.query(
          `INSERT INTO order_lines (order_id, variant_id, quantity, unit_price_cents, created_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::double precision / 1000))`,
          [orderId, variantIds[i], line.quantity ?? 1, line.price ?? 1500, i],
        );
      }
      return { orderId, token, variantIds, total: orderTotal };
    });
  }

  function pay(order: { orderId: string; token: string }, store = storeId): Promise<CheckoutOutcome> {
    return startCheckout(
      { stripe: () => fake.stripe },
      { storeId: store, orderId: order.orderId, cartToken: order.token, origin: ORIGIN },
    );
  }

  /** The session a redirect outcome sends the Customer to. */
  function sessionOf(outcome: CheckoutOutcome) {
    expect(outcome.kind).toBe("redirect");
    const url = outcome.kind === "redirect" ? outcome.url : "";
    const session = [...fake.sessions.values()].find((s) => s.url === url);
    expect(session, `no fake session has the url ${url}`).toBeDefined();
    return session!;
  }

  /** Whether the Order's current attempt still has a start time (it is not ended). */
  async function attemptStarted(orderId: string): Promise<boolean> {
    const { rows } = await pool.query<{ started: boolean }>(
      `SELECT checkout_started_at IS NOT NULL AS started FROM orders WHERE id = $1`,
      [orderId],
    );
    return rows[0]!.started;
  }

  async function recorded(orderId: string): Promise<{ sessionId: string | null; attempt: number }> {
    const { rows } = await pool.query<{ checkout_session_id: string | null; checkout_attempt: number }>(
      `SELECT checkout_session_id, checkout_attempt FROM orders WHERE id = $1`,
      [orderId],
    );
    return { sessionId: rows[0]!.checkout_session_id, attempt: rows[0]!.checkout_attempt };
  }

  function availability(order: { orderId: string; token: string }) {
    return getCheckoutAvailability(
      { stripe: () => fake.stripe },
      { storeId, orderId: order.orderId, cartToken: order.token },
    );
  }

  const newPaymentIntentId = () => `pi_${randomUUID().replaceAll("-", "")}`;

  /** The Customer paid the session (card): Stripe completed it, paid. Returns the PaymentIntent id. */
  function completePaid(session: FakeSession): string {
    const paymentIntent = newPaymentIntentId();
    Object.assign(session, {
      status: "complete",
      payment_status: "paid",
      paymentIntent: { id: paymentIntent, status: "succeeded" },
    });
    return paymentIntent;
  }

  /** The Payment the webhook recorded for a session's PaymentIntent. */
  async function recordPayment(
    order: { orderId: string; total: number },
    sessionId: string,
    paymentIntent: string,
    status: "refund_due" | "refunded" | "refund_failed",
  ): Promise<void> {
    await asStore(storeId, (client) =>
      client.query(
        `INSERT INTO payments (order_id, stripe_account_id, payment_intent_id, checkout_session_id, amount_cents, currency,
                               status, refund_reason, refund_error)
         VALUES ($1, $2, $3, $4, $5, 'usd', $6, 'insufficient_inventory', $7)`,
        [order.orderId, account, paymentIntent, sessionId, order.total, status, status === "refund_failed" ? "charge_disputed" : null],
      ),
    );
  }

  const creates = (): RecordedRequest[] =>
    fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/checkout/sessions");

  /** Sessions the fake created for `orderId` (whatever the test did since reset). */
  const sessionsFor = (orderId: string) =>
    [...fake.sessions.values()].filter((s) => s.metadata.shp0_order_id === orderId);

  describe("a new session", () => {
    it("is a direct charge on the Store's account, with exactly shp0's parameters and no fee", async () => {
      const order = await newOrder({
        lines: [
          { title: "Mug", variantTitle: "Default", price: 1500, quantity: 2 },
          { title: "Tee", variantTitle: "Large", price: 2500, quantity: 1 },
        ],
      });

      const outcome = await pay(order);

      expect(fake.requests).toHaveLength(1);
      const [request] = creates();
      expect(request).toMatchObject({
        method: "POST",
        path: "/v1/checkout/sessions",
        stripeAccount: account,
        idempotencyKey: `checkout:${order.orderId}:1`,
      });
      // Every parameter, so a fee, a transfer or anything else unexpected fails.
      expect(Object.fromEntries(request!.params)).toEqual({
        mode: "payment",
        "line_items[0][quantity]": "2",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": "1500",
        "line_items[0][price_data][product_data][name]": "Mug",
        "line_items[1][quantity]": "1",
        "line_items[1][price_data][currency]": "usd",
        "line_items[1][price_data][unit_amount]": "2500",
        "line_items[1][price_data][product_data][name]": "Tee — Large",
        success_url: `${ORIGIN}/order/${order.orderId}?checkout=returned`,
        cancel_url: `${ORIGIN}/order/${order.orderId}`,
        client_reference_id: order.orderId,
        "metadata[shp0_store_id]": storeId,
        "metadata[shp0_order_id]": order.orderId,
        "payment_intent_data[metadata][shp0_store_id]": storeId,
        "payment_intent_data[metadata][shp0_order_id]": order.orderId,
      });

      const session = sessionOf(outcome);
      expect(session.amount_total).toBe(order.total);
      expect(session.account).toBe(account);
      expect(await recorded(order.orderId)).toEqual({ sessionId: session.id, attempt: 1 });
    });

    it("names every line on Stripe's page, even one whose Product has no title", async () => {
      const order = await newOrder({
        lines: [
          { title: " ", variantTitle: "Large" },
          { title: "", variantTitle: "Default" },
        ],
      });
      sessionOf(await pay(order));
      const params = creates()[0]!.params;
      expect(params.get("line_items[0][price_data][product_data][name]")).toBe("Large");
      expect(params.get("line_items[1][price_data][product_data][name]")).toBe("Item");
    });

    it("is not delivered when the Order stops being payable while Stripe creates it", async () => {
      const order = await newOrder();
      // The Merchant voids the Order while shp0 waits on Stripe.
      fake.beforeNextReply(async () => {
        await pool.query(`UPDATE orders SET payment_status = 'voided' WHERE id = $1`, [order.orderId]);
      });

      expect(await pay(order)).toEqual({ kind: "blocked", reason: "not_pending" });
      expect(creates()).toHaveLength(1);
      expect((await recorded(order.orderId)).sessionId).toBeNull();
    });
  });

  describe("one live session per Order", () => {
    it("reuses the recorded session while it is open", async () => {
      const order = await newOrder();
      const first = await pay(order);
      const second = await pay(order);

      expect(second).toEqual(first);
      expect(creates()).toHaveLength(1);
      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /v1/checkout/sessions",
        `GET /v1/checkout/sessions/${sessionOf(first).id}`,
      ]);
      expect(fake.requests[1]!.stripeAccount).toBe(account);
    });

    it("replaces an expired session with a new one, under the next attempt's key", async () => {
      const order = await newOrder();
      const first = sessionOf(await pay(order));
      first.status = "expired";

      const second = sessionOf(await pay(order));

      expect(second.id).not.toBe(first.id);
      expect(creates().map((r) => r.idempotencyKey)).toEqual([
        `checkout:${order.orderId}:1`,
        `checkout:${order.orderId}:2`,
      ]);
      expect(await recorded(order.orderId)).toEqual({ sessionId: second.id, attempt: 2 });
    });

    it("says the payment is processing while a paid session has not been recorded yet", async () => {
      const order = await newOrder();
      const session = sessionOf(await pay(order));
      Object.assign(session, {
        status: "complete",
        payment_status: "paid",
        paymentIntent: { id: `pi_${randomUUID().slice(0, 8)}`, status: "succeeded" },
      });

      expect(await pay(order)).toEqual({ kind: "blocked", reason: "processing" });
      expect(creates()).toHaveLength(1);
    });

    it("starts a new session when the paid session's payment was refunded", async () => {
      // Stock ran out between Pay and payment: the webhook refunded it and the
      // Order stayed pending, so it can be paid again (ADR-0006).
      const order = await newOrder();
      const session = sessionOf(await pay(order));
      await recordPayment(order, session.id, completePaid(session), "refunded");

      const next = sessionOf(await pay(order));
      expect(next.id).not.toBe(session.id);
      expect(creates().at(-1)!.idempotencyKey).toBe(`checkout:${order.orderId}:2`);
    });

    it("blocks Pay while the paid session's refund is still owed or has failed: that money is still held", async () => {
      for (const status of ["refund_due", "refund_failed"] as const) {
        const order = await newOrder();
        const session = sessionOf(await pay(order));
        await recordPayment(order, session.id, completePaid(session), status);

        expect(await pay(order), status).toEqual({ kind: "blocked", reason: "refund_pending" });
        expect(await availability(order), status).toEqual({ available: false, reason: "refund_pending" });
        expect(await recorded(order.orderId)).toEqual({ sessionId: session.id, attempt: 1 });
      }
      expect(creates()).toHaveLength(2);
    });

    it("starts a new session when a delayed payment was canceled, or the session took no payment", async () => {
      const canceled = await newOrder();
      const first = sessionOf(await pay(canceled));
      Object.assign(first, {
        status: "complete",
        payment_status: "unpaid",
        paymentIntent: { id: newPaymentIntentId(), status: "canceled" },
      });
      expect(sessionOf(await pay(canceled)).id).not.toBe(first.id);

      const free = await newOrder();
      const second = sessionOf(await pay(free));
      Object.assign(second, { status: "complete", payment_status: "no_payment_required", paymentIntent: null });
      expect(sessionOf(await pay(free)).id).not.toBe(second.id);
    });

    it("waits on a delayed payment method, and starts a new session once it has failed", async () => {
      const order = await newOrder();
      const session = sessionOf(await pay(order));
      Object.assign(session, {
        status: "complete",
        payment_status: "unpaid",
        paymentIntent: { id: `pi_${randomUUID().slice(0, 8)}`, status: "processing" },
      });
      expect(await pay(order)).toEqual({ kind: "blocked", reason: "processing" });

      session.paymentIntent = { ...session.paymentIntent!, status: "requires_payment_method" };
      const next = sessionOf(await pay(order));
      expect(next.id).not.toBe(session.id);
      expect(creates()).toHaveLength(2);
    });

    it("starts a new session when the recorded one does not exist on the Store's account", async () => {
      const order = await newOrder();
      await pool.query(`UPDATE orders SET checkout_session_id = 'cs_test_gone', checkout_attempt = 1 WHERE id = $1`, [
        order.orderId,
      ]);

      const session = sessionOf(await pay(order));
      expect(creates().map((r) => r.idempotencyKey)).toEqual([`checkout:${order.orderId}:2`]);
      expect(await recorded(order.orderId)).toEqual({ sessionId: session.id, attempt: 2 });
    });

    it("gives a Pay that races another's reservation the winner's session, through the winner's key", async () => {
      const order = await newOrder();

      const outcomes = await Promise.all([pay(order), pay(order)]);

      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(sessionsFor(order.orderId)).toHaveLength(1);
      expect(new Set(creates().map((r) => r.idempotencyKey))).toEqual(new Set([`checkout:${order.orderId}:1`]));
      expect(await recorded(order.orderId)).toEqual({ sessionId: sessionOf(outcomes[0]!).id, attempt: 1 });
    });

    it("tells a Pay that finds Stripe still creating the Order's session to wait, and delivers that one session", async () => {
      const order = await newOrder();
      let arrived!: () => void;
      const createArrived = new Promise<void>((resolve) => (arrived = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      // Stripe holds the first Pay's create open.
      fake.beforeNextReply(async () => {
        arrived();
        await released;
      });

      const first = pay(order);
      await createArrived;
      const second = await pay(order);
      // The 409 does not end the attempt the first Pay is still creating.
      expect(await attemptStarted(order.orderId)).toBe(true);
      release();

      // The second Pay re-sent attempt 1's key; Stripe answered 409 once (no SDK retry).
      expect(second).toEqual({ kind: "blocked", reason: "in_progress" });
      const session = sessionOf(await first);
      expect(sessionsFor(order.orderId)).toHaveLength(1);
      expect(creates().map((r) => [r.idempotencyKey, "status" in r.reply ? r.reply.status : "dropped"])).toEqual([
        [`checkout:${order.orderId}:1`, 409],
        [`checkout:${order.orderId}:1`, 200],
      ]);
      expect(await recorded(order.orderId)).toEqual({ sessionId: session.id, attempt: 1 });
    });

    it("never delivers a session whose attempt was superseded while Stripe created it", async () => {
      const order = await newOrder();
      // Each time Stripe answers, the Order has already moved on to a newer attempt.
      for (let i = 0; i < 3; i++) {
        fake.beforeNextReply(async () => {
          await pool.query(
            `UPDATE orders SET checkout_attempt = checkout_attempt + 1, checkout_started_at = now() WHERE id = $1`,
            [order.orderId],
          );
        });
      }

      expect(await pay(order)).toEqual({ kind: "blocked", reason: "in_progress" });
      expect(creates()).toHaveLength(3);
      expect((await recorded(order.orderId)).sessionId).toBeNull();
    });

    it("ends an attempt whose create failed, so the next Pay starts a new one at once", async () => {
      const order = await newOrder();
      fake.reply(stripeError(500, "api_error"));

      await expect(pay(order)).rejects.toThrow();
      // One request: Pay turns the SDK's retries off.
      expect(creates()).toHaveLength(1);
      expect(await recorded(order.orderId)).toEqual({ sessionId: null, attempt: 1 });

      // Stripe keeps attempt 1's 500 for its key; the next Pay uses attempt 2's.
      const session = sessionOf(await pay(order));
      expect(creates().map((r) => r.idempotencyKey)).toEqual([
        `checkout:${order.orderId}:1`,
        `checkout:${order.orderId}:2`,
      ]);
      expect(await recorded(order.orderId)).toEqual({ sessionId: session.id, attempt: 2 });
    });

    it("ends only its own attempt when a failed create comes back after a newer attempt started", async () => {
      const order = await newOrder();
      // While Stripe fails attempt 1, another Pay has already started attempt 2.
      fake.beforeNextReply(async () => {
        await pool.query(`UPDATE orders SET checkout_attempt = 2, checkout_started_at = now() WHERE id = $1`, [
          order.orderId,
        ]);
      });
      fake.reply(stripeError(500, "api_error"));
      await expect(pay(order)).rejects.toThrow();

      // Attempt 2 is still being created: the next Pay re-sends its key.
      expect(await attemptStarted(order.orderId)).toBe(true);
      const session = sessionOf(await pay(order));
      expect(creates().map((r) => r.idempotencyKey)).toEqual([
        `checkout:${order.orderId}:1`,
        `checkout:${order.orderId}:2`,
      ]);
      expect(await recorded(order.orderId)).toEqual({ sessionId: session.id, attempt: 2 });
    });

    it("re-sends an attempt's key within the lease, and starts a new attempt after it", async () => {
      const recent = await newOrder();
      const stale = await newOrder();
      for (const [order, age] of [
        [recent, 59],
        [stale, 61],
      ] as const) {
        await pool.query(
          `UPDATE orders SET checkout_attempt = 1, checkout_started_at = now() - make_interval(secs => $2) WHERE id = $1`,
          [order.orderId, age],
        );
      }

      sessionOf(await pay(recent));
      sessionOf(await pay(stale));
      expect(creates().map((r) => r.idempotencyKey)).toEqual([
        `checkout:${recent.orderId}:1`,
        `checkout:${stale.orderId}:2`,
      ]);
    });

    it("reserves no attempt when the Stripe client cannot be created (no key)", async () => {
      const order = await newOrder();
      const noClient = () => {
        throw new Error("no Stripe key");
      };
      await expect(
        startCheckout(
          { stripe: noClient },
          { storeId, orderId: order.orderId, cartToken: order.token, origin: ORIGIN },
        ),
      ).rejects.toThrow("no Stripe key");
      expect(await recorded(order.orderId)).toEqual({ sessionId: null, attempt: 0 });
      expect(await attemptStarted(order.orderId)).toBe(false);
    });

    it("changes nothing when Stripe fails while Pay checks the recorded session", async () => {
      const order = await newOrder();
      const session = sessionOf(await pay(order));
      fake.reply(stripeError(500, "api_error"));

      await expect(pay(order)).rejects.toThrow();
      expect(fake.requests.map((r) => r.method)).toEqual(["POST", "GET"]);
      expect(await recorded(order.orderId)).toEqual({ sessionId: session.id, attempt: 1 });
    });
  });

  describe("no session for an Order that cannot be paid", () => {
    it("not found: another cart token, another Store, no such Order", async () => {
      const order = await newOrder();
      const otherStore = await newStore("checkout-other");
      const cases: Array<[string, string, string | null]> = [
        [storeId, order.orderId, randomUUID()],
        [storeId, order.orderId, null],
        [otherStore, order.orderId, order.token],
        [storeId, randomUUID(), order.token],
        [storeId, "not-a-uuid", order.token],
      ];
      for (const [store, orderId, cartToken] of cases) {
        expect(await startCheckout({ stripe: () => fake.stripe }, { storeId: store, orderId, cartToken, origin: ORIGIN })).toEqual({
          kind: "blocked",
          reason: "not_found",
        });
      }
      expect(fake.requests).toEqual([]);
    });

    it("not pending: paid, voided or cancelled", async () => {
      for (const paymentStatus of ["paid", "voided", "cancelled"]) {
        const order = await newOrder({ paymentStatus });
        expect(await pay(order)).toEqual({ kind: "blocked", reason: "not_pending" });
      }
      expect(fake.requests).toEqual([]);
    });

    it("not chargeable: outside Stripe's amount limits, over 100 lines, or lines that do not add up", async () => {
      const orders = [
        await newOrder({ lines: [{ price: 0 }] }),
        await newOrder({ lines: [{ price: 49 }] }),
        await newOrder({ lines: [{ price: 100_000_000 }] }),
        await newOrder({ lines: Array.from({ length: 101 }, () => ({ price: 100 })) }),
        await newOrder({ lines: [{ price: 1500 }], total: 1400 }),
      ];
      for (const order of orders) {
        expect(await pay(order)).toEqual({ kind: "blocked", reason: "not_chargeable" });
      }
      expect(fake.requests).toEqual([]);
    });

    it("takes the smallest and largest amounts Stripe allows", async () => {
      sessionOf(await pay(await newOrder({ lines: [{ price: 50 }] })));
      sessionOf(await pay(await newOrder({ lines: [{ price: 99_999_999 }] })));
      sessionOf(await pay(await newOrder({ lines: Array.from({ length: 100 }, () => ({ price: 100 })) })));
    });

    it("item unavailable: a Variant was deleted", async () => {
      const order = await newOrder({ lines: [{}, {}] });
      await asStore(storeId, (client) => client.query(`DELETE FROM variants WHERE id = $1`, [order.variantIds[1]]));

      expect(await pay(order)).toEqual({ kind: "blocked", reason: "item_unavailable" });
      expect(fake.requests).toEqual([]);
    });

    it("out of stock: not enough inventory, counting every line of a Variant", async () => {
      const short = await newOrder({ lines: [{ quantity: 2, inventory: 1 }] });
      expect(await pay(short)).toEqual({ kind: "blocked", reason: "out_of_stock" });

      const twice = await newOrder({ lines: [{ quantity: 1, inventory: 1 }] });
      const both = await newOrder({
        lines: [
          { quantity: 1, variantId: twice.variantIds[0] },
          { quantity: 1, variantId: twice.variantIds[0] },
        ],
        total: 3000,
      });
      expect(await pay(both)).toEqual({ kind: "blocked", reason: "out_of_stock" });
      expect(fake.requests).toEqual([]);
    });

    it("payments not set up: no Stripe account, or one that cannot take payments yet", async () => {
      const noAccount = await newStore("checkout-noacct");
      const notReady = await newStore("checkout-notready");
      await upsertPaymentAccount({ storeId: notReady, connectAccountId: newAccountId(), chargesEnabled: false });

      for (const store of [noAccount, notReady]) {
        const order = await newOrder({ store });
        expect(await pay(order, store)).toEqual({ kind: "blocked", reason: "payments_not_set_up" });
      }
      expect(fake.requests).toEqual([]);
    });
  });

  describe("paying the session", () => {
    it("pays the Order through the webhook, which accepts the session Pay created", async () => {
      const order = await newOrder({ lines: [{ quantity: 2, inventory: 5 }] });
      const session = sessionOf(await pay(order));
      const paymentIntent = `pi_${randomUUID().replaceAll("-", "")}`;
      const payload = JSON.stringify({
        id: `evt_${randomUUID().replaceAll("-", "")}`,
        object: "event",
        type: "checkout.session.completed",
        account,
        livemode: false,
        data: {
          object: {
            id: session.id,
            object: "checkout.session",
            status: "complete",
            payment_status: "paid",
            amount_total: session.amount_total,
            currency: session.currency,
            metadata: session.metadata,
            payment_intent: paymentIntent,
          },
        },
      });
      const secret = "whsec_test_checkout";
      const response = await handleStripeWebhook(
        payload,
        fake.stripe.webhooks.generateTestHeaderString({ payload, secret }),
        { stripe: fake.stripe, webhookSecret: secret, livemode: false },
      );

      expect(response).toEqual({ status: 200, body: { received: true } });
      expect(await getStorefrontOrder(storeId, order.orderId, order.token)).toMatchObject({
        paymentStatus: "paid",
        payment: { status: "paid", refundReason: null },
      });
      const { rows } = await pool.query(`SELECT inventory FROM variants WHERE id = $1`, [order.variantIds[0]]);
      expect(rows[0].inventory).toBe(3);
    });

    it("shows the Order page the current session's refunded Payment, not an earlier session's", async () => {
      const order = await newOrder();
      const first = sessionOf(await pay(order));
      const paymentIntent = `pi_${randomUUID().replaceAll("-", "")}`;
      await asStore(storeId, (client) =>
        client.query(
          `INSERT INTO payments (order_id, stripe_account_id, payment_intent_id, checkout_session_id, amount_cents, currency, status, refund_reason)
           VALUES ($1, $2, $3, $4, $5, 'usd', 'refunded', 'insufficient_inventory')`,
          [order.orderId, account, paymentIntent, first.id, order.total],
        ),
      );
      expect((await getStorefrontOrder(storeId, order.orderId, order.token))!.payment).toEqual({
        status: "refunded",
        refundReason: "insufficient_inventory",
      });

      Object.assign(first, {
        status: "complete",
        payment_status: "paid",
        paymentIntent: { id: paymentIntent, status: "succeeded" },
      });
      sessionOf(await pay(order));
      expect((await getStorefrontOrder(storeId, order.orderId, order.token))!.payment).toBeNull();
    });
  });

  describe("getCheckoutAvailability (the Order page's Pay button)", () => {
    it("answers as Pay would, for the Order and its recorded session, and creates nothing", async () => {
      const payable = await newOrder();
      const soldOut = await newOrder({ lines: [{ quantity: 3, inventory: 2 }] });
      const paid = await newOrder({ paymentStatus: "paid" });
      expect(await availability(payable)).toEqual({ available: true });
      expect(await availability(soldOut)).toEqual({ available: false, reason: "out_of_stock" });
      expect(await availability(paid)).toEqual({ available: false, reason: "not_pending" });
      expect(await availability({ orderId: payable.orderId, token: randomUUID() })).toEqual({
        available: false,
        reason: "not_found",
      });
      // No recorded session: no need to ask Stripe.
      expect(fake.requests).toEqual([]);

      const open = await newOrder();
      sessionOf(await pay(open));
      const processing = await newOrder();
      completePaid(sessionOf(await pay(processing)));
      const refunded = await newOrder();
      const refundedSession = sessionOf(await pay(refunded));
      await recordPayment(refunded, refundedSession.id, completePaid(refundedSession), "refunded");
      const createsBefore = creates().length;

      expect(await availability(open)).toEqual({ available: true });
      expect(await availability(processing)).toEqual({ available: false, reason: "processing" });
      expect(await availability(refunded)).toEqual({ available: true });
      expect(creates()).toHaveLength(createsBefore);
    });

    it("reports a payment in flight before anything that has changed since, and never gives out an open session for an Order that cannot be paid", async () => {
      // A delayed payment is processing; meanwhile the stock has gone.
      const paying = await newOrder({ lines: [{ quantity: 1, inventory: 1 }] });
      const session = sessionOf(await pay(paying));
      Object.assign(session, {
        status: "complete",
        payment_status: "unpaid",
        paymentIntent: { id: newPaymentIntentId(), status: "processing" },
      });
      // An open session; meanwhile the stock has gone.
      const open = await newOrder({ lines: [{ quantity: 1, inventory: 1 }] });
      sessionOf(await pay(open));
      await pool.query(`UPDATE variants SET inventory = 0 WHERE id = ANY($1::uuid[])`, [
        [...paying.variantIds, ...open.variantIds],
      ]);

      expect(await availability(paying)).toEqual({ available: false, reason: "processing" });
      expect(await pay(paying)).toEqual({ kind: "blocked", reason: "processing" });
      expect(await availability(open)).toEqual({ available: false, reason: "out_of_stock" });
      expect(await pay(open)).toEqual({ kind: "blocked", reason: "out_of_stock" });
    });

    it("answers from shp0's own data without creating a Stripe client when no session is recorded", async () => {
      const soldOut = await newOrder({ lines: [{ quantity: 2, inventory: 1 }] });
      const noClient = () => {
        throw new Error("no Stripe key");
      };
      expect(
        await getCheckoutAvailability({ stripe: noClient }, { storeId, orderId: soldOut.orderId, cartToken: soldOut.token }),
      ).toEqual({ available: false, reason: "out_of_stock" });
    });
  });
});

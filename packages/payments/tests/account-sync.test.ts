import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { applySchema, closePools, getPaymentAccount, provisionStore, savePaymentAccount } from "@shp0/db";

import { connectStripeAccount, handleStripeAccountEvent, startCheckout, syncStripeAccount } from "../src/index";
import {
  activeAccountState,
  newAccountState,
  startFakeStripe,
  stripeError,
  type FakeAccount,
  type FakeStripe,
} from "./fake-stripe";
import { newAccountId, seedStripeAccount, sign, thinEvent, THIN_SECRET } from "./stripe-accounts";

/**
 * Whether a Store can take card payments is read from Stripe, never taken
 * from the Merchant or the URL (ADR-0006 point 2): the Payments page reads the
 * saved account from Stripe each time it is opened, and a read that began
 * earlier never overwrites a later one.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";

describe("Reading a Store's Stripe account from Stripe (ADR-0006)", () => {
  let pool: Pool;
  let fake: FakeStripe;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: PLATFORM_URL });
    fake = await startFakeStripe({ clientRetries: 2 });
  });

  afterAll(async () => {
    await fake.close();
    await pool.end();
    await closePools();
  });

  beforeEach(() => {
    fake.reset();
  });

  async function newStore(): Promise<string> {
    const ownerId = `owner-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [ownerId, `${ownerId}@sync.test`]);
    const { store } = await provisionStore({ name: "Sync", subdomain: `sync-${randomUUID().slice(0, 8)}`, ownerId });
    return store.id;
  }

  /** A Store with a saved account the fake knows, in `state`. */
  async function storeWithAccount(state: Partial<FakeAccount> = {}): Promise<{ store: string; account: string }> {
    const store = await newStore();
    const account = newAccountId();
    fake.accounts.set(account, {
      id: account,
      metadata: { shp0_store_id: store },
      created: new Date().toISOString(),
      ...newAccountState(),
      ...state,
    });
    await savePaymentAccount(store, account);
    return { store, account };
  }

  const sync = (store: string) => syncStripeAccount({ stripe: () => fake.stripe }, store);

  it("reads the saved account as the platform, with the merchant configuration and requirements", async () => {
    const { store, account } = await storeWithAccount();

    await sync(store);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "GET",
      path: `/v2/core/accounts/${account}`,
      stripeAccount: undefined,
      stripeContext: undefined,
    });
    expect([...fake.requests[0]!.query]).toEqual([
      ["include[0]", "configuration.merchant"],
      ["include[1]", "requirements"],
    ]);
  });

  it.each<[string, Partial<FakeAccount>, { chargesEnabled: boolean; cardPaymentsStatus: string | null }]>([
    ["active", activeAccountState(), { chargesEnabled: true, cardPaymentsStatus: "active" }],
    ["onboarding not done", newAccountState(), { chargesEnabled: false, cardPaymentsStatus: "restricted" }],
    ["pending", { cardPayments: { status: "pending", status_details: [] } }, { chargesEnabled: false, cardPaymentsStatus: "pending" }],
    [
      "unsupported",
      { cardPayments: { status: "unsupported", status_details: [{ code: "unsupported_country", resolution: "no_resolution" }] } },
      { chargesEnabled: false, cardPaymentsStatus: "unsupported" },
    ],
    ["closed", { ...activeAccountState(), closed: true }, { chargesEnabled: false, cardPaymentsStatus: "active" }],
    ["merchant configuration not applied", { ...activeAccountState(), applied: false }, { chargesEnabled: false, cardPaymentsStatus: "active" }],
    ["configuration not returned", { ...activeAccountState(), hideConfiguration: true }, { chargesEnabled: false, cardPaymentsStatus: null }],
  ])("records what Stripe reports: %s", async (_name, state, expected) => {
    const { store } = await storeWithAccount(state);

    const view = await sync(store);

    expect(view).toMatchObject({ connected: true, fresh: true, missing: false, canTakePayments: expected.chargesEnabled });
    expect(await getPaymentAccount(store)).toMatchObject(expected);
  });

  it("asks Stripe nothing for a Store with no account", async () => {
    expect(await sync(await newStore())).toEqual({ connected: false });
    expect(fake.requests).toEqual([]);
  });

  it.each<[string, () => void]>([
    ["Stripe unavailable", () => fake.reply(stripeError(500, "api_error"))],
    ["connection dropped", () => [0, 1].forEach(() => fake.reply({ dropConnection: true }))],
  ])("keeps what Stripe last reported when it cannot be read: %s", async (_name, fail) => {
    const { store } = await storeWithAccount(activeAccountState());
    await sync(store);
    fail();

    const view = await sync(store);

    expect(view).toMatchObject({ connected: true, fresh: false, summary: null, canTakePayments: true, cardPayments: "active" });
    expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: true, cardPaymentsStatus: "active" });
  });

  it("records not able for an account Stripe no longer has, and keeps its id", async () => {
    const store = await newStore();
    const gone = newAccountId();
    await seedStripeAccount(store, gone, "active");

    const view = await sync(store);

    expect(view).toMatchObject({ connected: true, fresh: true, missing: true, canTakePayments: false });
    expect(await getPaymentAccount(store)).toMatchObject({ connectAccountId: gone, chargesEnabled: false, cardPaymentsStatus: null });
  });

  it("never lets a read that began earlier overwrite a later one", async () => {
    const { store, account } = await storeWithAccount(activeAccountState());
    const fakeAccount = fake.accounts.get(account)!;
    // While read A waits on Stripe, the account is restricted and read B records it; then A's answer arrives.
    fake.beforeNextReply(async () => {
      Object.assign(fakeAccount, newAccountState());
      await sync(store);
      Object.assign(fakeAccount, activeAccountState());
    });

    await sync(store);

    expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: false, cardPaymentsStatus: "restricted" });

    // The mirror case: an older "not able" never overwrites a newer "able".
    fake.beforeNextReply(async () => {
      Object.assign(fakeAccount, activeAccountState());
      await sync(store);
      Object.assign(fakeAccount, newAccountState());
    });
    await sync(store);
    expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: true, cardPaymentsStatus: "active" });
  });

  it("Pay follows Stripe: blocked until Stripe reports card payments active, and again once they are not", async () => {
    const store = await newStore();
    const origin = "https://app.shp0.test";
    await connectStripeAccount({ stripe: () => fake.stripe }, { storeId: store, origin });
    const [account] = [...fake.accounts.keys()];

    // An Order the Customer can pay, placed with a cart token.
    const token = randomUUID();
    const orderId = await (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.store_id', $1, true)`, [store]);
        const { rows: products } = await client.query(
          `INSERT INTO products (title, slug, status) VALUES ('Mug', $1, 'published') RETURNING id`,
          [`mug-${randomUUID()}`],
        );
        const { rows: variants } = await client.query(
          `INSERT INTO variants (product_id, sku, title, price_cents, inventory) VALUES ($1, $2, 'Default', 1500, 5) RETURNING id`,
          [products[0].id, `SKU-${randomUUID()}`],
        );
        const { rows: orders } = await client.query(
          `INSERT INTO orders (customer_id, total_cents) VALUES ($1, 1500) RETURNING id`,
          [token],
        );
        await client.query(`INSERT INTO order_lines (order_id, variant_id, quantity, unit_price_cents) VALUES ($1, $2, 1, 1500)`, [
          orders[0].id,
          variants[0].id,
        ]);
        await client.query("COMMIT");
        return orders[0].id as string;
      } finally {
        client.release();
      }
    })();
    const pay = () =>
      startCheckout({ stripe: () => fake.stripe }, { storeId: store, orderId, cartToken: token, origin: "https://shop.test" });

    expect(await pay()).toEqual({ kind: "blocked", reason: "payments_not_set_up" });

    Object.assign(fake.accounts.get(account!)!, activeAccountState());
    await sync(store);
    const paying = await pay();
    expect(paying.kind).toBe("redirect");
    const create = fake.requests.find((r) => r.method === "POST" && r.path === "/v1/checkout/sessions");
    expect(create?.stripeAccount).toBe(account);

    // Stripe restricts card payments; its account event makes shp0 read it again.
    Object.assign(fake.accounts.get(account!)!, newAccountState());
    const payload = thinEvent({ type: "v2.core.account[configuration.merchant].capability_status_updated", account: account! });
    const response = await handleStripeAccountEvent(payload, sign(fake.stripe, payload), {
      stripe: fake.stripe,
      secret: THIN_SECRET,
      livemode: false,
    });
    expect(response.status).toBe(200);
    expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: false });
  });
});

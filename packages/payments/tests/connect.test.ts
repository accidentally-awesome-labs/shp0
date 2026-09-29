import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { applySchema, closePools, getPaymentAccount, provisionStore, savePaymentAccount } from "@shp0/db";

import { connectStripeAccount } from "../src/index";
import {
  activeAccountState,
  newAccountState,
  startFakeStripe,
  stripeError,
  type FakeReply,
  type FakeStripe,
  type RecordedRequest,
} from "./fake-stripe";
import { newAccountId, seedStripeAccount } from "./stripe-accounts";

/**
 * Connect: an Admin sets up the Store's own Stripe account (ADR-0006 point 2).
 * One Accounts v2 account per Store, created with the key account:<Store id>
 * and saved as soon as Stripe returns it, before onboarding; a second or
 * concurrent attempt reuses it, and a saved account is never replaced.
 *
 * The Stripe API is the local fake (tests/fake-stripe.ts), with production's
 * default of 2 SDK retries; what shp0 saved is read back from Postgres.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";
const ORIGIN = "https://app.shp0.test";

describe("Connect a Store's Stripe account (ADR-0006)", () => {
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
    vi.restoreAllMocks();
  });

  async function newStore(): Promise<string> {
    const ownerId = `owner-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [ownerId, `${ownerId}@connect.test`]);
    const { store } = await provisionStore({ name: "Connect", subdomain: `connect-${randomUUID().slice(0, 8)}`, ownerId });
    return store.id;
  }

  const connect = (storeId: string, origin = ORIGIN) => connectStripeAccount({ stripe: () => fake.stripe }, { storeId, origin });

  const creates = (): RecordedRequest[] => fake.requests.filter((r) => r.method === "POST" && r.path === "/v2/core/accounts");
  const links = (): RecordedRequest[] => fake.requests.filter((r) => r.path === "/v2/core/account_links");
  const statusOf = (r: RecordedRequest) => ("status" in r.reply ? r.reply.status : "dropped");

  async function savedRows(storeId: string) {
    return (await pool.query(`SELECT connect_account_id FROM stripe_payment_accounts WHERE store_id = $1`, [storeId])).rows.map(
      (r) => r.connect_account_id as string,
    );
  }

  /** Resolves once `predicate` holds for the fake's recorded requests. */
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!predicate()) throw new Error("timed out waiting on the fake Stripe");
  }

  it("creates one Accounts v2 account with exactly ADR-0006's parameters, under account:<Store id>", async () => {
    const store = await newStore();

    const outcome = await connect(store);

    expect(creates()).toHaveLength(1);
    const [create] = creates();
    expect(create!.body).toEqual({
      dashboard: "full",
      defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      metadata: { shp0_store_id: store },
    });
    expect(create).toMatchObject({
      idempotencyKey: `account:${store}`,
      stripeAccount: undefined,
      stripeContext: undefined,
      stripeVersion: "2026-06-24.dahlia",
    });
    expect(fake.requests.some((r) => r.path.startsWith("/v1/account"))).toBe(false);
    expect(outcome).toEqual({ kind: "onboarding", url: expect.stringMatching(/^https:\/\/connect\.stripe\.test\/setup\//) });
  });

  it("saves the account before it asks Stripe for the onboarding link", async () => {
    const store = await newStore();
    let savedAtLink: unknown;
    fake.beforeNextReply(async () => undefined); // the create
    fake.beforeNextReply(async () => {
      savedAtLink = await getPaymentAccount(store); // the link
    });

    await connect(store);

    const [account] = [...fake.accounts.keys()];
    expect(savedAtLink).toEqual({
      connectAccountId: account,
      chargesEnabled: false,
      cardPaymentsStatus: null,
      statusCheckedAt: null,
    });
  });

  it("asks for an onboarding link for the saved account, returning to the Store's Payments page", async () => {
    const store = await newStore();

    const outcome = await connect(store);

    const [account] = [...fake.accounts.keys()];
    expect(links()).toHaveLength(1);
    expect(links()[0]!.body).toEqual({
      account,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["merchant"],
          refresh_url: `${ORIGIN}/dashboard/${store}/payments?stripe=refresh`,
          return_url: `${ORIGIN}/dashboard/${store}/payments?stripe=return`,
        },
      },
    });
    expect(outcome).toEqual({ kind: "onboarding", url: (links()[0]!.reply as { body: { url: string } }).body.url });
    expect(await savedRows(store)).toEqual([account]);
  });

  it("reuses the saved account on a second Connect: it reads it from Stripe, and creates nothing", async () => {
    const store = await newStore();
    await connect(store);
    fake.requests.length = 0;

    const outcome = await connect(store);

    const [account] = [...fake.accounts.keys()];
    expect(outcome.kind).toBe("onboarding");
    expect(creates()).toEqual([]);
    expect(fake.requests.map((r) => `${r.method} ${r.path}?${r.query}`)).toEqual([
      `GET /v2/core/accounts/${account}?include%5B0%5D=configuration.merchant&include%5B1%5D=requirements`,
      "POST /v2/core/account_links?",
    ]);
    expect(fake.accounts.size).toBe(1);
  });

  it("gives two concurrent Connects the same account: the second waits on Stripe's key and gets its replay", async () => {
    const store = await newStore();
    let arrived!: () => void;
    const createArrived = new Promise<void>((resolve) => (arrived = resolve));
    fake.beforeNextReply(async () => {
      arrived();
      // Hold the first create until Stripe has refused the second (in use).
      await until(() => creates().some((r) => statusOf(r) === 409));
    });

    const first = connect(store);
    await createArrived;
    const outcomes = await Promise.all([first, connect(store)]);

    expect(outcomes.map((o) => o.kind)).toEqual(["onboarding", "onboarding"]);
    expect(fake.accounts.size).toBe(1);
    expect(await savedRows(store)).toEqual([...fake.accounts.keys()]);
    expect(new Set(creates().map((r) => r.idempotencyKey))).toEqual(new Set([`account:${store}`]));
  });

  it("tells a Connect that finds Stripe still creating the account to try again, and saves one account", async () => {
    const store = await newStore();
    let arrived!: () => void;
    const createArrived = new Promise<void>((resolve) => (arrived = resolve));
    fake.beforeNextReply(async () => {
      arrived();
      // Hold the first create through the second's request and both SDK retries.
      await until(() => creates().filter((r) => statusOf(r) === 409).length === 3);
    });

    const first = connect(store);
    await createArrived;
    const second = await connect(store);

    expect(second).toEqual({ kind: "busy" });
    expect((await first).kind).toBe("onboarding");
    expect(fake.accounts.size).toBe(1);
    expect(await savedRows(store)).toHaveLength(1);
  });

  it("gets the same account back when Stripe created it but the answer was lost", async () => {
    const store = await newStore();
    fake.reply({ saveThenDrop: true });

    const outcome = await connect(store);

    expect(outcome.kind).toBe("onboarding");
    expect(creates().map((r) => [r.idempotencyKey, r.dropped])).toEqual([
      [`account:${store}`, true],
      [`account:${store}`, false],
    ]);
    expect(fake.accounts.size).toBe(1);
    expect(await savedRows(store)).toEqual([...fake.accounts.keys()]);
  });

  it("makes no link when the account cannot be saved; the next Connect gets the same account back and saves it", async () => {
    const store = await newStore();
    const suffix = randomUUID().replaceAll("-", "");
    await pool.query(`
      CREATE FUNCTION refuse_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'database unavailable'; END $$;
      CREATE TRIGGER refuse_${suffix} BEFORE INSERT ON stripe_payment_accounts
        FOR EACH ROW WHEN (NEW.store_id = '${store}') EXECUTE FUNCTION refuse_${suffix}();`);
    try {
      await expect(connect(store)).rejects.toThrow();
      expect(links()).toEqual([]);
      expect(await savedRows(store)).toEqual([]);
    } finally {
      await pool.query(`DROP TRIGGER refuse_${suffix} ON stripe_payment_accounts; DROP FUNCTION refuse_${suffix}();`);
    }

    const outcome = await connect(store);

    expect(outcome.kind).toBe("onboarding");
    expect(creates().map((r) => r.idempotencyKey)).toEqual([`account:${store}`, `account:${store}`]);
    expect(fake.accounts.size).toBe(1);
    expect(await savedRows(store)).toEqual([...fake.accounts.keys()]);
  });

  it("never replaces a saved account: an account created meanwhile is logged, not saved", async () => {
    const store = await newStore();
    const savedFirst = newAccountId();
    fake.accounts.set(savedFirst, { id: savedFirst, metadata: {}, created: new Date().toISOString(), ...newAccountState() });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fake.beforeNextReply(async () => {
      // Another attempt saved an account while this one was being created.
      await savePaymentAccount(store, savedFirst);
    });

    const outcome = await connect(store);

    const created = [...fake.accounts.keys()].find((id) => id !== savedFirst)!;
    expect(outcome.kind).toBe("onboarding");
    expect((links()[0]!.body as { account: string }).account).toBe(savedFirst);
    expect(await savedRows(store)).toEqual([savedFirst]);
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain(created);
    expect(logged).toContain(savedFirst);
    expect(logged).toContain(store);
  });

  it.each<[string, FakeReply[]]>([
    ["Stripe unavailable (500)", [stripeError(500, "api_error")]],
    [
      "rate limited",
      [0, 1, 2].map(() => ({ status: 429, body: { error: { type: "rate_limit", code: "rate_limit", message: "slow down" } } })),
    ],
    ["rate limited (v1 error type)", [0, 1, 2].map(() => stripeError(429, "rate_limit"))],
    ["connection dropped", [0, 1, 2].map(() => ({ dropConnection: true as const }))],
  ])("reports Stripe unavailable, and saves and links nothing: %s", async (_name, replies) => {
    const store = await newStore();
    for (const reply of replies) fake.reply(reply);

    expect(await connect(store)).toEqual({ kind: "unavailable" });
    expect(links()).toEqual([]);
    expect(await savedRows(store)).toEqual([]);
  });

  it("rejects Stripe's refusal with its code, and saves and links nothing", async () => {
    const store = await newStore();
    fake.reply(stripeError(400, "invalid_fields", "contact_email is required"));

    await expect(connect(store)).rejects.toMatchObject({ code: "invalid_fields" });
    expect(links()).toEqual([]);
    expect(await savedRows(store)).toEqual([]);
  });

  it("whether Stripe keeps a refused create or not, a Store never ends up with two accounts", async () => {
    for (const v2ReplayErrors of [true, false]) {
      const replaying = await startFakeStripe({ clientRetries: 2, v2ReplayErrors });
      try {
        const store = await newStore();
        const retry = () => connectStripeAccount({ stripe: () => replaying.stripe }, { storeId: store, origin: ORIGIN });
        replaying.reply(stripeError(400, "invalid_fields"));
        await expect(retry()).rejects.toMatchObject({ code: "invalid_fields" });

        if (v2ReplayErrors) {
          await expect(retry()).rejects.toMatchObject({ code: "invalid_fields" });
          expect(replaying.accounts.size).toBe(0);
        } else {
          expect((await retry()).kind).toBe("onboarding");
          expect(replaying.accounts.size).toBe(1);
        }
        expect((await savedRows(store)).length).toBe(replaying.accounts.size);
      } finally {
        await replaying.close();
      }
    }
  });

  it("makes no link for an account that can take payments and needs nothing", async () => {
    const store = await newStore();
    await connect(store);
    const [account] = [...fake.accounts.keys()];
    Object.assign(fake.accounts.get(account!)!, activeAccountState());
    fake.requests.length = 0;

    expect(await connect(store)).toEqual({ kind: "active" });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /v2/core/accounts/${account}`]);
    expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: true, cardPaymentsStatus: "active" });

    // Stripe asks for more information: a link to give it.
    fake.accounts.get(account!)!.requirements = newAccountState().requirements;
    expect((await connect(store)).kind).toBe("onboarding");
  });

  it("reports a closed account, or one Stripe no longer has, and creates no other", async () => {
    const closedStore = await newStore();
    await connect(closedStore);
    const [closed] = [...fake.accounts.keys()];
    fake.accounts.get(closed!)!.closed = true;
    expect(await connect(closedStore)).toEqual({ kind: "closed" });

    const goneStore = await newStore();
    const gone = newAccountId();
    await seedStripeAccount(goneStore, gone, "active");
    expect(await connect(goneStore)).toEqual({ kind: "missing" });
    expect(await getPaymentAccount(goneStore)).toMatchObject({ connectAccountId: gone, chargesEnabled: false });

    expect(creates()).toHaveLength(1);
    expect(await savedRows(closedStore)).toEqual([closed]);
  });

  it("refuses a malformed Store id or origin before asking Stripe anything", async () => {
    const store = await newStore();
    await expect(connect("not-a-uuid")).rejects.toThrow();
    for (const origin of ["https://app.shp0.test/x", "javascript:alert(1)", ""]) {
      await expect(connect(store, origin), origin).rejects.toThrow();
    }
    expect(fake.requests).toEqual([]);
  });
});

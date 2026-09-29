import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";

import {
  applySchema,
  closePools,
  getPaymentAccount,
  getStoreIdByConnectAccount,
  provisionStore,
  recordStripeAccountStatus,
  savePaymentAccount,
  startStripeAccountRead,
} from "../src/index";

/**
 * A Store's Stripe account (ADR-0006 point 2): saved once, as soon as Stripe
 * returns it, and never replaced; one account per Store and one Store per
 * account; whether it can take card payments comes only from a read of
 * Stripe, and a read that began earlier never overwrites a later one.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";
const TENANT_URL = "postgresql:///shp0_test?user=default";

const accountId = () => `acct_${randomBytes(8).toString("hex")}`;

describe("A Store's Stripe account (ADR-0006)", () => {
  let pool: Pool;
  let tenant: Pool;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: PLATFORM_URL });
    tenant = new Pool({ connectionString: TENANT_URL });
  });

  afterAll(async () => {
    await tenant.end();
    await pool.end();
    await closePools();
  });

  async function newStore(): Promise<string> {
    const ownerId = `owner-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [
      ownerId,
      `${ownerId}@accounts.test`,
    ]);
    const { store } = await provisionStore({
      name: "Accounts",
      subdomain: `accounts-${randomUUID().slice(0, 8)}`,
      ownerId,
    });
    return store.id;
  }

  async function row(storeId: string) {
    const { rows } = await pool.query(`SELECT * FROM stripe_payment_accounts WHERE store_id = $1`, [storeId]);
    return rows;
  }

  describe("savePaymentAccount: saved once, never replaced", () => {
    it("saves the first account, and a later one is not saved: the first is returned", async () => {
      const store = await newStore();
      const first = accountId();
      const second = accountId();

      expect(await savePaymentAccount(store, first)).toEqual({ accountId: first, saved: true });
      expect(await savePaymentAccount(store, second)).toEqual({ accountId: first, saved: false });
      expect((await row(store)).map((r) => r.connect_account_id)).toEqual([first]);
      expect(await getPaymentAccount(store)).toEqual({
        connectAccountId: first,
        chargesEnabled: false,
        cardPaymentsStatus: null,
        statusCheckedAt: null,
      });
    });

    it("keeps one account when two are saved for a Store at once", async () => {
      const store = await newStore();
      const results = await Promise.all([savePaymentAccount(store, accountId()), savePaymentAccount(store, accountId())]);

      expect(new Set(results.map((r) => r.accountId)).size).toBe(1);
      expect(results.filter((r) => r.saved)).toHaveLength(1);
      expect(await row(store)).toHaveLength(1);
    });

    it("refuses an account another Store already has, and saves nothing for the second Store", async () => {
      const [a, b] = [await newStore(), await newStore()];
      const shared = accountId();
      await savePaymentAccount(a, shared);

      await expect(savePaymentAccount(b, shared)).rejects.toThrow();
      expect(await row(b)).toEqual([]);
      expect(await getStoreIdByConnectAccount(shared)).toBe(a);
    });

    it("refuses anything that is not a Stripe account id, before touching the database", async () => {
      const store = await newStore();
      for (const bad of ["", "acct_", "acct_x;--", "cus_123", "acct_ spaced"]) {
        await expect(savePaymentAccount(store, bad), bad).rejects.toThrow();
      }
      await expect(savePaymentAccount("not-a-uuid", accountId())).rejects.toThrow();
      expect(await row(store)).toEqual([]);
    });

    it("the database itself refuses to change a saved account id, or move it to another Store", async () => {
      const [a, b] = [await newStore(), await newStore()];
      const saved = accountId();
      await savePaymentAccount(a, saved);

      await expect(
        pool.query(`UPDATE stripe_payment_accounts SET connect_account_id = $2 WHERE store_id = $1`, [a, accountId()]),
      ).rejects.toThrow(/never replaced/);
      await expect(
        pool.query(`UPDATE stripe_payment_accounts SET store_id = $2 WHERE store_id = $1`, [a, b]),
      ).rejects.toThrow(/never replaced/);
      expect((await row(a)).map((r) => r.connect_account_id)).toEqual([saved]);
    });

    it("keeps the table's rules: status values, and card payments only with an active status", async () => {
      const store = await newStore();
      await savePaymentAccount(store, accountId());
      const bad: Array<[string, unknown[]]> = [
        [`UPDATE stripe_payment_accounts SET charges_enabled = true WHERE store_id = $1`, [store]],
        [
          `UPDATE stripe_payment_accounts SET charges_enabled = true, card_payments_status = 'pending' WHERE store_id = $1`,
          [store],
        ],
        [`UPDATE stripe_payment_accounts SET card_payments_status = 'enabled' WHERE store_id = $1`, [store]],
        [
          `INSERT INTO stripe_payment_accounts (store_id, connect_account_id) VALUES ($1, 'acct_x;--')`,
          [await newStore()],
        ],
      ];
      for (const [text, values] of bad) {
        await expect(pool.query(text, values), text).rejects.toThrow(/violates check constraint/);
      }
      expect((await row(store))[0]).toMatchObject({ charges_enabled: false, card_payments_status: null });
    });
  });

  describe("recording what Stripe reports", () => {
    it("finds the saved account by Store or by account id, with strictly increasing read tickets", async () => {
      const store = await newStore();
      const saved = accountId();
      await savePaymentAccount(store, saved);

      const byStore = await startStripeAccountRead({ storeId: store });
      const byAccount = await startStripeAccountRead({ accountId: saved });
      expect(byStore).toMatchObject({ storeId: store, accountId: saved });
      expect(byAccount).toMatchObject({ storeId: store, accountId: saved });
      expect(BigInt(byAccount!.read)).toBeGreaterThan(BigInt(byStore!.read));

      expect(await startStripeAccountRead({ storeId: await newStore() })).toBeNull();
      expect(await startStripeAccountRead({ accountId: accountId() })).toBeNull();
      expect(await startStripeAccountRead({ storeId: "not-a-uuid" })).toBeNull();
    });

    it("records a read, and a read that began earlier never overwrites a later one", async () => {
      const store = await newStore();
      const saved = accountId();
      await savePaymentAccount(store, saved);
      const earlier = (await startStripeAccountRead({ storeId: store }))!;
      const later = (await startStripeAccountRead({ storeId: store }))!;

      expect(await recordStripeAccountStatus(later, { cardPayments: "restricted", canTakePayments: false })).toBe(
        "recorded",
      );
      // The earlier read saw the account active, but it is older: not recorded.
      expect(await recordStripeAccountStatus(earlier, { cardPayments: "active", canTakePayments: true })).toBe("stale");

      const account = await getPaymentAccount(store);
      expect(account).toMatchObject({ connectAccountId: saved, chargesEnabled: false, cardPaymentsStatus: "restricted" });
      expect(account!.statusCheckedAt).toBeInstanceOf(Date);

      const newest = (await startStripeAccountRead({ accountId: saved }))!;
      expect(await recordStripeAccountStatus(newest, { cardPayments: "active", canTakePayments: true })).toBe("recorded");
      expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: true, cardPaymentsStatus: "active" });
    });

    it("records not able for an account Stripe no longer reports, and never touches the account id", async () => {
      const store = await newStore();
      const saved = accountId();
      await savePaymentAccount(store, saved);
      const active = (await startStripeAccountRead({ storeId: store }))!;
      await recordStripeAccountStatus(active, { cardPayments: "active", canTakePayments: true });

      const gone = (await startStripeAccountRead({ storeId: store }))!;
      expect(await recordStripeAccountStatus(gone, { cardPayments: null, canTakePayments: false })).toBe("recorded");
      expect(await getPaymentAccount(store)).toMatchObject({
        connectAccountId: saved,
        chargesEnabled: false,
        cardPaymentsStatus: null,
      });
    });

    it("refuses a read for an account the Store does not have", async () => {
      const store = await newStore();
      await savePaymentAccount(store, accountId());
      const forged = { storeId: store, accountId: accountId(), read: "999999999999" };

      expect(await recordStripeAccountStatus(forged, { cardPayments: "active", canTakePayments: true })).toBe("stale");
      expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: false });
    });
  });

  it("keeps the table away from the tenant role", async () => {
    const store = await newStore();
    await savePaymentAccount(store, accountId());
    for (const text of [
      `SELECT * FROM stripe_payment_accounts`,
      `UPDATE stripe_payment_accounts SET charges_enabled = false`,
      `INSERT INTO stripe_payment_accounts (store_id, connect_account_id) VALUES ('${store}', 'acct_tenant')`,
      `SELECT nextval('stripe_account_reads')`,
    ]) {
      await expect(tenant.query(text), text).rejects.toThrow(/permission denied/);
    }
  });
});

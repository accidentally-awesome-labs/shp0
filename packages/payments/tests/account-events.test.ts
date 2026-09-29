import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { applySchema, closePools, getPaymentAccount, provisionStore, savePaymentAccount } from "@shp0/db";

import { handleStripeAccountEvent, handleStripeWebhook } from "../src/index";
import { activeAccountState, newAccountState, startFakeStripe, stripeError, type FakeReply, type FakeStripe } from "./fake-stripe";
import { newAccountId, sign, thinEvent, THIN_SECRET } from "./stripe-accounts";

/**
 * Account events (ADR-0006 points 2 and 4): Stripe's thin events about an
 * Accounts v2 account arrive on their own route, signed with their own
 * secret. Each one only makes shp0 read the account from Stripe again; the
 * event's body is never trusted, so a redelivery only reads again.
 */

const PLATFORM_URL = "postgresql:///shp0_test?user=cloud_admin";
const V1_SECRET = "whsec_test_secret";
const CAPABILITY = "v2.core.account[configuration.merchant].capability_status_updated";

describe("Stripe account events (ADR-0006)", () => {
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

  /** A Store with a saved account the fake knows, active unless `state` says otherwise. */
  async function storeWithAccount(state = activeAccountState()): Promise<{ store: string; account: string }> {
    const ownerId = `owner-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [ownerId, `${ownerId}@events.test`]);
    const store = (await provisionStore({ name: "Events", subdomain: `events-${randomUUID().slice(0, 8)}`, ownerId })).store.id;
    const account = newAccountId();
    fake.accounts.set(account, { id: account, metadata: { shp0_store_id: store }, created: new Date().toISOString(), ...state });
    await savePaymentAccount(store, account);
    return { store, account };
  }

  const deliver = (payload: string, signature: string | null = sign(fake.stripe, payload), livemode = false) =>
    handleStripeAccountEvent(payload, signature, { stripe: fake.stripe, secret: THIN_SECRET, livemode });

  describe("anything that is not a verified thin event about a Store's account", () => {
    it("answers 400 to a missing, wrong, stale or tampered signature, and asks Stripe nothing", async () => {
      const { account } = await storeWithAccount();
      const payload = thinEvent({ type: CAPABILITY, account });
      const cases: Array<[string, string, string | null]> = [
        ["missing", payload, null],
        ["the v1 endpoint's secret", payload, sign(fake.stripe, payload, V1_SECRET)],
        ["400 seconds old", payload, sign(fake.stripe, payload, THIN_SECRET, Math.floor(Date.now() / 1000) - 400)],
        ["tampered", payload.replace(account, newAccountId()), sign(fake.stripe, payload)],
      ];
      for (const [name, body, signature] of cases) {
        expect((await deliver(body, signature)).status, name).toBe(400);
      }
      expect(fake.requests).toEqual([]);
    });

    it("keeps v1 events and thin events on their own routes and secrets", async () => {
      const { account, store } = await storeWithAccount(newAccountState());
      // A signed v1 event on the thin route: not a thin event, ignored.
      const v1 = JSON.stringify({ id: "evt_v1", object: "event", type: "account.updated", livemode: false, account, data: { object: {} } });
      expect(await deliver(v1)).toMatchObject({ status: 200, body: { ignored: expect.any(String) } });
      // A signed thin event on the v1 route: refused there.
      const thin = thinEvent({ type: CAPABILITY, account });
      const v1Route = await handleStripeWebhook(thin, sign(fake.stripe, thin, V1_SECRET), {
        stripe: fake.stripe,
        webhookSecret: V1_SECRET,
        livemode: false,
      });
      expect(v1Route.status).toBe(400);
      expect(fake.requests).toEqual([]);
      expect(await getPaymentAccount(store)).toMatchObject({ cardPaymentsStatus: null });
    });

    it("ignores the other mode, event types it does not handle, and accounts that are no Store's", async () => {
      const { account } = await storeWithAccount();
      const cases = [
        thinEvent({ type: CAPABILITY, account, livemode: true }),
        thinEvent({ type: "v2.core.event_destination.ping", account: null }),
        thinEvent({ type: "v2.core.account_person.updated", account }),
        thinEvent({ type: "v2.core.account[identity].updated", account }),
        thinEvent({ type: CAPABILITY, account: null }),
        thinEvent({ type: CAPABILITY, account: "cus_not_an_account" }),
        thinEvent({ type: CAPABILITY, account: newAccountId() }),
      ];
      for (const payload of cases) {
        expect(await deliver(payload), payload).toMatchObject({ status: 200, body: { ignored: expect.any(String) } });
      }
      expect(fake.requests).toEqual([]);
    });
  });

  describe("an event about a Store's account", () => {
    it.each([
      CAPABILITY,
      "v2.core.account[configuration.merchant].updated",
      "v2.core.account[requirements].updated",
      "v2.core.account.updated",
      "v2.core.account.closed",
    ])("%s: reads the account from Stripe and records what it reports", async (type) => {
      const { store, account } = await storeWithAccount();

      expect(await deliver(thinEvent({ type, account }))).toEqual({ status: 200, body: { received: true } });

      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /v2/core/accounts/${account}`]);
      expect([...fake.requests[0]!.query].map(([, value]) => value)).toEqual(["configuration.merchant", "requirements"]);
      expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: true, cardPaymentsStatus: "active" });
    });

    it("trusts nothing in the event but which account it is about", async () => {
      const { store, account } = await storeWithAccount(newAccountState());
      const payload = thinEvent({
        type: CAPABILITY,
        account,
        context: "acct_someoneelse",
        extra: {
          changes: { status: "active" },
          related_object: { id: account, type: "v2.core.account", url: "/v2/core/accounts/acct_other?include[0]=nothing" },
        },
      });

      expect((await deliver(payload)).status).toBe(200);

      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]).toMatchObject({
        path: `/v2/core/accounts/${account}`,
        stripeAccount: undefined,
        stripeContext: undefined,
      });
      expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: false, cardPaymentsStatus: "restricted" });
    });

    it("reads again on a redelivery, and keeps no record of the event", async () => {
      const { store, account } = await storeWithAccount();
      const payload = thinEvent({ type: CAPABILITY, account });
      const id = (JSON.parse(payload) as { id: string }).id;

      expect((await deliver(payload)).status).toBe(200);
      expect((await deliver(payload)).status).toBe(200);

      expect(fake.requests).toHaveLength(2);
      expect(await getPaymentAccount(store)).toMatchObject({ chargesEnabled: true });
      expect((await pool.query(`SELECT 1 FROM processed_events WHERE id = $1`, [id])).rows).toEqual([]);
    });

    it.each<[string, FakeReply[]]>([
      ["Stripe unavailable", [stripeError(500, "api_error")]],
      ["rate limited", [{ status: 429, body: { error: { type: "rate_limit", code: "rate_limit", message: "slow down" } } }]],
      ["connection dropped", [{ dropConnection: true }, { dropConnection: true }]],
      ["the platform key refused", [stripeError(401, "api_key_expired")]],
    ])("answers 500 so Stripe delivers it again, and changes nothing: %s", async (_name, replies) => {
      const { store, account } = await storeWithAccount();
      for (const reply of replies) fake.reply(reply);

      expect((await deliver(thinEvent({ type: CAPABILITY, account }))).status).toBe(500);
      expect(await getPaymentAccount(store)).toMatchObject({ cardPaymentsStatus: null, chargesEnabled: false });
    });

    it("records not able for an account Stripe no longer has, and answers 200", async () => {
      const { store, account } = await storeWithAccount();
      fake.accounts.delete(account);

      expect((await deliver(thinEvent({ type: "v2.core.account.closed", account }))).status).toBe(200);
      expect(await getPaymentAccount(store)).toMatchObject({ connectAccountId: account, chargesEnabled: false });
    });

    it("answers 200 to a refusal a retry cannot fix, changes nothing, and logs its code", async () => {
      const { store, account } = await storeWithAccount();
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fake.reply(stripeError(400, "invalid_request"));

      expect((await deliver(thinEvent({ type: CAPABILITY, account }))).status).toBe(200);
      expect(await getPaymentAccount(store)).toMatchObject({ cardPaymentsStatus: null });
      expect(error.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("invalid_request");
    });

    it("logs the event's id, type and account, never its body", async () => {
      const logs: string[] = [];
      for (const level of ["log", "info", "warn", "error"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
      }
      const payload = thinEvent({
        type: "v2.core.account[identity].updated",
        account: newAccountId(),
        extra: { changes: { secret_marker: "PAYLOAD-MARKER-4242" } },
      });

      await deliver(payload);

      const id = (JSON.parse(payload) as { id: string }).id;
      expect(logs.join("\n")).toContain(id);
      expect(logs.join("\n")).not.toContain("PAYLOAD-MARKER-4242");
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  provisionStore,
  createProduct,
  getOrCreateDbCart,
  saveDbCartLines,
  checkout,
  hashPassword,
  verifyPassword,
  signUpCustomer,
  signInCustomer,
  signOutCustomer,
  getCustomerBySession,
  CustomerSignUpError,
  startCustomerSignIn,
  startCustomerSignUp,
  listCustomers,
  listCustomerOrders,
  addCustomerAddress,
  listCustomerAddresses,
} from "../src/index";

/**
 * Issue #13 — Customer identity (per-Store, RLS-protected).
 */
describe("Customer identity (Issue #13)", () => {
  let pool: Pool;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE addresses, customer_sessions, customers, discount_redemptions, discounts, collection_products, collections, cart_items, carts, order_lines, orders, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );

    const userA = randomUUID();
    const userB = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${userA}, 'A', 'a@example.com'), (${userB}, 'B', 'b@example.com')`,
    );
    const a = await provisionStore({ name: "Alpha", subdomain: "alpha-cust", ownerId: userA });
    storeAId = a.store.id;
    const b = await provisionStore({ name: "Beta", subdomain: "beta-cust", ownerId: userB });
    storeBId = b.store.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  it("creates a customer scoped to Store A (invisible to Store B via RLS)", async () => {
    const result = await signUpCustomer(storeAId, {
      email: "shopper@example.com",
      password: "password123",
      name: "Test Shopper",
    });
    expect(result.customerId).toBeDefined();
    const storeACustomers = await listCustomers(storeAId);
    expect(storeACustomers).toHaveLength(1);
    expect(storeACustomers[0]!.email).toBe("shopper@example.com");
    const storeBCustomers = await listCustomers(storeBId);
    expect(storeBCustomers).toHaveLength(0);
  });

  it("the same email on Store A and Store B are two separate customers", async () => {
    const resultB = await signUpCustomer(storeBId, {
      email: "shopper@example.com",
      password: "different456",
      name: "Store B Shopper",
    });
    expect(resultB.customerId).toBeDefined();
    const storeACustomers = await listCustomers(storeAId);
    const storeBCustomers = await listCustomers(storeBId);
    expect(storeACustomers).toHaveLength(1);
    expect(storeBCustomers).toHaveLength(1);
    expect(storeACustomers[0]!.name).toBe("Test Shopper");
    expect(storeBCustomers[0]!.name).toBe("Store B Shopper");
  });

  it("signs in with the correct password and rejects the wrong one", async () => {
    const session = await signInCustomer(storeAId, {
      email: "shopper@example.com",
      password: "password123",
    });
    expect(session).not.toBeNull();
    expect(session!.token).toBeDefined();
    expect(session!.customerId).toBeDefined();
    const failed = await signInCustomer(storeAId, {
      email: "shopper@example.com",
      password: "wrongpassword",
    });
    expect(failed).toBeNull();
    // An email with no account, and Store B's Customer in Store A, are no sign-in either.
    expect(await signInCustomer(storeAId, { email: "nobody@example.com", password: "password123" })).toBeNull();
    expect(await signInCustomer(storeAId, { email: "shopper@example.com", password: "different456" })).toBeNull();
  });

  it("refuses a second Customer with the same email in the Store, with a typed reason, and adds no row", async () => {
    const before = await listCustomers(storeAId);
    const again = signUpCustomer(storeAId, { email: "shopper@example.com", password: "another123", name: "Again" });
    await expect(again).rejects.toBeInstanceOf(CustomerSignUpError);
    await expect(again).rejects.toMatchObject({ reason: "email_taken" });
    expect(await listCustomers(storeAId)).toEqual(before);
  });

  it("signs a Customer out: that session no longer resolves, their other sessions and other Stores' stay", async () => {
    const credentials = { email: "shopper@example.com", password: "password123" };
    const phone = await signInCustomer(storeAId, credentials);
    const laptop = await signInCustomer(storeAId, credentials);

    // Another Store cannot end Store A's session (RLS): nothing changes.
    await signOutCustomer(storeBId, phone!.token);
    expect(await getCustomerBySession(storeAId, phone!.token)).not.toBeNull();

    await signOutCustomer(storeAId, phone!.token);

    expect(await getCustomerBySession(storeAId, phone!.token)).toBeNull();
    expect(await getCustomerBySession(storeAId, laptop!.token)).toMatchObject({ email: "shopper@example.com" });
    // Signing out twice, or with a token that is no session, is harmless.
    await expect(signOutCustomer(storeAId, phone!.token)).resolves.toBeUndefined();
    await expect(signOutCustomer(storeAId, "not-a-token")).resolves.toBeUndefined();
  });

  it("resolves a session token to the correct customer + store", async () => {
    const session = await signInCustomer(storeAId, {
      email: "shopper@example.com",
      password: "password123",
    });
    const resolved = await getCustomerBySession(storeAId, session!.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.email).toBe("shopper@example.com");
    expect(resolved!.name).toBe("Test Shopper");
  });

  it("hashes passwords with scrypt and verifies them (constant-time)", () => {
    const hash = hashPassword("mypassword");
    expect(hash).not.toBe("mypassword");
    expect(verifyPassword("mypassword", hash)).toBe(true);
    expect(verifyPassword("wrongpassword", hash)).toBe(false);
  });

  it("adds and lists addresses for a customer (RLS-scoped)", async () => {
    const customers = await listCustomers(storeAId);
    const customerId = customers[0]!.id;
    await addCustomerAddress(storeAId, customerId, {
      fullName: "Test Shopper",
      line1: "123 Main St",
      city: "Springfield",
      region: "IL",
      postalCode: "62701",
      country: "US",
    });
    const addresses = await listCustomerAddresses(storeAId, customerId);
    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.line1).toBe("123 Main St");
  });

  it("lists orders for a customer", async () => {
    const customers = await listCustomers(storeAId);
    const customerId = customers[0]!.id;
    // Checkout sells only published Products.
    const product = await createProduct(storeAId, {
      title: "Item", description: "", slug: "item", status: "published",
      variants: [{ sku: "I-1", title: "Default", priceCents: 1000, inventory: 10 }],
    });
    await getOrCreateDbCart(storeAId, customerId);
    await saveDbCartLines(storeAId, customerId, [
      { variantId: product.variants[0]!.id, quantity: 1 },
    ]);
    await checkout(storeAId, customerId);
    const orders = await listCustomerOrders(storeAId, customerId);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.paymentStatus).toBe("pending");
  });

  describe("the storefront's sign-up and sign-in (startCustomerSignUp, startCustomerSignIn)", () => {
    /** A Store of its own, so these tests add no Customer to Store A. */
    async function newStore(): Promise<string> {
      const owner = randomUUID();
      await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [owner, `${owner}@example.com`]);
      const { store } = await provisionStore({ name: "Gamma", subdomain: `gamma-${owner.slice(0, 8)}`, ownerId: owner });
      return store.id;
    }
    const count = async (storeId: string) => (await listCustomers(storeId)).length;
    const signUp = { email: " pat@example.com ", name: " Pat ", password: "password123" };

    it("signs a new Customer up and in: the token resolves to them", async () => {
      const store = await newStore();

      const result = await startCustomerSignUp(store, signUp, null);

      expect(result).toEqual({ ok: true, token: expect.any(String) });
      expect(await getCustomerBySession(store, (result as { token: string }).token)).toMatchObject({
        email: "pat@example.com",
        name: "Pat",
      });
    });

    it("refuses what the form rules refuse, writing nothing", async () => {
      const store = await newStore();

      expect(await startCustomerSignUp(store, { ...signUp, password: "short" }, null)).toEqual({ ok: false, reason: "weak_password" });
      expect(await startCustomerSignUp(store, { ...signUp, email: "a\u0000b@example.com" }, null)).toEqual({
        ok: false,
        reason: "invalid_email",
      });
      expect(await count(store)).toBe(0);
    });

    it("refuses a taken email with its reason, and signs no one in", async () => {
      const store = await newStore();
      await startCustomerSignUp(store, signUp, null);

      expect(await startCustomerSignUp(store, { ...signUp, name: "Someone else" }, null)).toEqual({ ok: false, reason: "email_taken" });
      expect(await count(store)).toBe(1);
    });

    it("lets any other failure through, as an error (not a form message)", async () => {
      const store = await newStore();
      const suffix = randomUUID().replaceAll("-", "");
      await pool.query(`
        CREATE FUNCTION refuse_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'database unavailable'; END $$;
        CREATE TRIGGER refuse_${suffix} BEFORE INSERT ON customers
          FOR EACH ROW WHEN (NEW.store_id = '${store}') EXECUTE FUNCTION refuse_${suffix}();`);
      try {
        await expect(startCustomerSignUp(store, signUp, null)).rejects.toThrow(/database unavailable/);
      } finally {
        await pool.query(`DROP TRIGGER refuse_${suffix} ON customers; DROP FUNCTION refuse_${suffix}();`);
      }
    });

    it("signs a Customer in with the right password, and never says which of email or password was wrong", async () => {
      const store = await newStore();
      await startCustomerSignUp(store, signUp, null);

      const result = await startCustomerSignIn(store, { email: "pat@example.com", password: "password123" }, null);
      expect(result).toEqual({ ok: true, token: expect.any(String) });
      expect(await startCustomerSignIn(store, { email: "pat@example.com", password: "wrong-password" }, null)).toEqual({
        ok: false,
        reason: "wrong_credentials",
      });
      expect(await startCustomerSignIn(store, { email: "nobody@example.com", password: "password123" }, null)).toEqual({
        ok: false,
        reason: "wrong_credentials",
      });
      expect(await startCustomerSignIn(store, { email: "a\u0000b@example.com", password: "password123" }, null)).toEqual({
        ok: false,
        reason: "wrong_credentials",
      });
    });

    it("ends the session the browser had before, on sign-in and on sign-up", async () => {
      const store = await newStore();
      const first = await startCustomerSignUp(store, signUp, null);
      const before = (first as { token: string }).token;

      const again = await startCustomerSignIn(store, { email: "pat@example.com", password: "password123" }, before);
      const after = (again as { token: string }).token;
      expect(after).not.toBe(before);
      expect(await getCustomerBySession(store, before)).toBeNull();
      expect(await getCustomerBySession(store, after)).not.toBeNull();

      // A sign-up in the same browser ends the signed-in Customer's session too.
      const other = await startCustomerSignUp(store, { ...signUp, email: "sam@example.com", name: "Sam" }, after);
      expect(await getCustomerBySession(store, after)).toBeNull();
      expect(await getCustomerBySession(store, (other as { token: string }).token)).toMatchObject({ name: "Sam" });

      // A refused attempt keeps the session the browser has.
      const kept = (other as { token: string }).token;
      await startCustomerSignIn(store, { email: "pat@example.com", password: "wrong-password" }, kept);
      expect(await getCustomerBySession(store, kept)).not.toBeNull();
    });

    it("still starts the new session if ending the browser's previous one fails, and logs it", async () => {
      const store = await newStore();
      const first = await startCustomerSignUp(store, signUp, null);
      const before = (first as { token: string }).token;
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const suffix = randomUUID().replaceAll("-", "");
      await pool.query(`
        CREATE FUNCTION refuse_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'database unavailable'; END $$;
        CREATE TRIGGER refuse_${suffix} BEFORE DELETE ON customer_sessions
          FOR EACH ROW WHEN (OLD.store_id = '${store}') EXECUTE FUNCTION refuse_${suffix}();`);
      try {
        const again = await startCustomerSignIn(store, { email: "pat@example.com", password: "password123" }, before);

        // The new session is committed: the Customer is signed in with it.
        expect(again).toEqual({ ok: true, token: expect.any(String) });
        expect(await getCustomerBySession(store, (again as { token: string }).token)).not.toBeNull();
        expect(error.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("database unavailable");
      } finally {
        await pool.query(`DROP TRIGGER refuse_${suffix} ON customer_sessions; DROP FUNCTION refuse_${suffix}();`);
        error.mockRestore();
      }
    });

    it("takes as long for an email with no account as for a wrong password, so timing does not tell them apart", async () => {
      const store = await newStore();
      await startCustomerSignUp(store, signUp, null);
      const median = async (email: string) => {
        const times: number[] = [];
        for (let i = 0; i < 7; i++) {
          const started = performance.now();
          await startCustomerSignIn(store, { email, password: "wrong-password" }, null);
          times.push(performance.now() - started);
        }
        return times.sort((a, b) => a - b)[3]!;
      };

      const known = await median("pat@example.com");
      const unknown = await median("nobody@example.com");

      // One scrypt each (tens of milliseconds); without it, an unknown email answers in a few.
      expect(unknown).toBeGreaterThan(known * 0.5);
    });
  });
});

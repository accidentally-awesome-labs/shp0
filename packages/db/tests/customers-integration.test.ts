import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
});

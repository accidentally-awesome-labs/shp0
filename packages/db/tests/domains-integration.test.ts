import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  provisionStore,
  addCustomDomain,
  resolveStoreByCustomDomain,
  applyDomainVerification,
  listCustomDomains,
} from "../src/index";

/**
 * Issue #14 — Custom Domain host→Store resolution + verification lifecycle.
 *
 * SECURITY: only VERIFIED domains resolve to a Store. Unverified/pending/failed
 * domains do NOT resolve (no Current Store).
 */
describe("Custom Domains (Issue #14)", () => {
  let pool: Pool;
  let storeId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE custom_domains, subscriptions, addresses, customer_sessions, customers, discount_redemptions, discounts, collection_products, collections, cart_items, carts, order_lines, orders, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );

    const user = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${user}, 'Dom', 'dom@example.com')`,
    );
    const s = await provisionStore({ name: "DomStore", subdomain: "dom-store", ownerId: user });
    storeId = s.store.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  it("adds a custom domain in 'pending' state", async () => {
    const result = await addCustomDomain(storeId, "shop.acme.com");
    expect(result.id).toBeDefined();
    expect(result.txtVerificationValue).toContain("shp0-verify=");

    const domains = await listCustomDomains(storeId);
    expect(domains).toHaveLength(1);
    expect(domains[0]!.hostname).toBe("shop.acme.com");
    expect(domains[0]!.verificationStatus).toBe("pending");
  });

  it("does NOT resolve a pending domain (security — only verified resolves)", async () => {
    const resolved = await resolveStoreByCustomDomain("shop.acme.com");
    expect(resolved).toBeNull();
  });

  it("verifies a domain (pending → verified), then it resolves to the Store", async () => {
    const domains = await listCustomDomains(storeId);
    const domainId = domains[0]!.id;

    const result = await applyDomainVerification(domainId, "dns_ok");
    expect(result).toEqual({ ok: true, status: "verified" });

    // Now it resolves!
    const resolved = await resolveStoreByCustomDomain("shop.acme.com");
    expect(resolved).toBe(storeId);
  });

  it("fails a verified domain on re-verify (verified → failed → STOPS resolving)", async () => {
    const domains = await listCustomDomains(storeId);
    const domainId = domains[0]!.id;

    // Re-verify fails.
    const result = await applyDomainVerification(domainId, "dns_fail");
    expect(result).toEqual({ ok: true, status: "failed" });

    // CRITICAL: it no longer resolves (security gate — domain-expiry-takeover hole closed).
    const resolved = await resolveStoreByCustomDomain("shop.acme.com");
    expect(resolved).toBeNull();
  });

  it("retries a failed domain (failed → pending), then verifies again", async () => {
    const domains = await listCustomDomains(storeId);
    const domainId = domains[0]!.id;

    // Merchant fixes DNS and retries.
    const retry = await applyDomainVerification(domainId, "retry");
    expect(retry).toEqual({ ok: true, status: "pending" });

    // Verify again.
    await applyDomainVerification(domainId, "dns_ok");
    const resolved = await resolveStoreByCustomDomain("shop.acme.com");
    expect(resolved).toBe(storeId);
  });
});

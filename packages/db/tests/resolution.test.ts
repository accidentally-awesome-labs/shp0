import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  provisionStore,
  parseSubdomain,
  authorizeStoreMembership,
  resolveStoreBySubdomain,
} from "../src/index";

/**
 * Issue #5 — Current Store resolution.
 */
describe("Current Store resolution (Issue #5)", () => {
  let pool: Pool;
  let userA: string;
  let userB: string;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    await applySchema();
    pool = new Pool({ connectionString: "postgresql:///shp0_test?user=cloud_admin" });
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE memberships, stores, "user", "session", "account", "verification" CASCADE`,
    );
    // Seed two Merchants.
    userA = randomUUID();
    userB = randomUUID();
    await db.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${userA}, 'Alice', 'alice@example.com'), (${userB}, 'Bob', 'bob@example.com')`,
    );
    // Alice creates Store A and Store B.
    const a = await provisionStore({ name: "Acme", subdomain: "acme-res", ownerId: userA });
    storeAId = a.store.id;
    const b = await provisionStore({ name: "Beta", subdomain: "beta-res", ownerId: userA });
    storeBId = b.store.id;
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  // ── Cycle 1: pure host parsing ──────────────────────────────────────
  describe("parseSubdomain", () => {
    it("extracts the subdomain from a storefront host", () => {
      expect(parseSubdomain("acme-res.shp0.dev", "shp0.dev")).toBe("acme-res");
      expect(parseSubdomain("beta-res.shp0.dev", "shp0.dev")).toBe("beta-res");
    });

    it("returns null for the platform domain itself (not a store)", () => {
      expect(parseSubdomain("shp0.dev", "shp0.dev")).toBe(null);
    });

    it("returns null for localhost / dev", () => {
      expect(parseSubdomain("localhost:3000", "shp0.dev")).toBe(null);
      expect(parseSubdomain("localhost", "shp0.dev")).toBe(null);
    });

    it("returns null for reserved subdomains (app, www, dashboard)", () => {
      expect(parseSubdomain("app.shp0.dev", "shp0.dev")).toBe(null);
      expect(parseSubdomain("www.shp0.dev", "shp0.dev")).toBe(null);
      expect(parseSubdomain("dashboard.shp0.dev", "shp0.dev")).toBe(null);
    });
  });

  // ── Cycle 2: dashboard Membership-authorized resolution ────────────
  describe("authorizeStoreMembership", () => {
    it("resolves when the Merchant holds a Membership for the Store", async () => {
      expect(await authorizeStoreMembership(userA, storeAId)).toBe(true);
      expect(await authorizeStoreMembership(userA, storeBId)).toBe(true);
    });

    it("rejects when the Merchant has no Membership for the Store", async () => {
      // userB has no Membership on either store.
      expect(await authorizeStoreMembership(userB, storeAId)).toBe(false);
      expect(await authorizeStoreMembership(userB, storeBId)).toBe(false);
    });
  });

  // ── Cycle 3: storefront host-based resolution ──────────────────────
  describe("resolveStoreBySubdomain", () => {
    it("resolves a Store by its subdomain", async () => {
      expect(await resolveStoreBySubdomain("acme-res")).toBe(storeAId);
      expect(await resolveStoreBySubdomain("beta-res")).toBe(storeBId);
    });

    it("returns null for a non-existent subdomain", async () => {
      expect(await resolveStoreBySubdomain("does-not-exist")).toBe(null);
    });
  });
});

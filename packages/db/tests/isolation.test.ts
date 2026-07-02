import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

import { tenantClient, platformClient, applySchema, closePools } from "../src/index";
import { stores } from "../src/schema";

/**
 * ADR-0001 — Postgres RLS for multi-tenant isolation.
 *
 * These are the platform's highest-risk, highest-leverage tests: they prove the
 * database itself enforces tenant isolation. If any of these fail, nothing built
 * on top of the data layer can be trusted.
 */
describe("RLS multi-tenant isolation (ADR-0001)", () => {
  let storeA: string;
  let storeB: string;

  beforeAll(async () => {
    await applySchema();
    // Seed two Stores via the platform client, which bypasses RLS (cloud_admin).
    // Store creation is a platform op: the platform mints the Store's id and sets
    // store_id = id (the tenant's own row).
    storeA = await platformClient(async (tx) => {
      await tx.execute(sql`TRUNCATE stores RESTART IDENTITY CASCADE`);
      const aId = randomUUID();
      await tx.insert(stores).values({ id: aId, storeId: aId, name: "Acme" });
      const bId = randomUUID();
      await tx.insert(stores).values({ id: bId, storeId: bId, name: "Beta" });
      storeB = bId;
      return aId;
    });
  });

  afterAll(async () => {
    await closePools();
  });

  it("a tenant client scoped to Store A sees only Store A, never Store B", async () => {
    const seen = await tenantClient(storeA, async (tx) => {
      return tx.select({ id: stores.id, name: stores.name }).from(stores);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(storeA);
    expect(seen[0]!.name).toBe("Acme");
  });

  it("is fail-closed: a tenant connection that bypasses tenantClient (no GUC set) sees zero rows", async () => {
    // Simulate a code path that escapes tenantClient and runs raw against the
    // tenant role with app.store_id never set. RLS must return nothing — never all.
    const pool = new Pool({ connectionString: "postgresql:///shp0_test?user=default" });
    try {
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM stores");
      expect(rows[0]!.n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("platformClient reads across Stores; a tenant client never can", async () => {
    const platformSeen = await platformClient(async (tx) => {
      return tx.select({ id: stores.id }).from(stores);
    });
    expect(platformSeen).toHaveLength(2);
    expect(platformSeen.map((s) => s.id).sort()).toEqual([storeA, storeB].sort());

    const tenantSeen = await tenantClient(storeB, async (tx) => {
      return tx.select({ id: stores.id }).from(stores);
    });
    expect(tenantSeen).toHaveLength(1);
    expect(tenantSeen[0]!.id).toBe(storeB);
  });
});


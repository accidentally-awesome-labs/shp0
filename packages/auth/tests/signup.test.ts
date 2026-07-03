import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import { applySchema, closePools } from "@shp0/db";
import { createAuth } from "../src/index";

/**
 * Issue #3 — Merchant identity.
 *
 * The tracer bullet: a Merchant can sign up with email/password, producing a
 * global (cross-Store) user row and a session. This validates the whole stack:
 * better-auth + Drizzle adapter + our Neon/pg pool + the platform (cloud_admin) role.
 */
describe("Merchant identity (Issue #3)", () => {
  let auth: ReturnType<typeof createAuth>;
  let pool: Pool;

  beforeAll(async () => {
    await applySchema();

    // Auth tables are platform tables (no store_id, no RLS) — connect as cloud_admin.
    pool = new Pool({
      connectionString:
        process.env.PLATFORM_DATABASE_URL ??
        "postgresql:///shp0_test?user=cloud_admin",
    });
    auth = createAuth(pool);

    // Clean auth tables so tests are hermetic across runs.
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE "user", "session", "account", "verification" CASCADE`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  it("a Merchant can sign up with email/password, creating a global user and a session", async () => {
    const result = await auth.api.signUpEmail({
      body: {
        email: "salar@example.com",
        password: "super-secret-password",
        name: "Salar",
      },
      returnHeaders: true,
    });

    const user = (result as any).user ?? (result as any).response?.user;
    expect(user).toBeDefined();
    expect(user.email).toBe("salar@example.com");
    expect(user.name).toBe("Salar");
    expect(user.id).toBeTruthy();

    // The session cookie is set in the response headers.
    const setCookie = (result as any).headers?.getSetCookie?.() ?? [];
    expect(setCookie.some((c: string) => c.includes("session"))).toBe(true);

    // The user is a real row in the database (global, not Store-scoped).
    const db = drizzle(pool);
    const rows = await db.execute(
      sql`SELECT email FROM "user" WHERE email = ${"salar@example.com"}`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("a Merchant can sign in with correct credentials; a wrong password is rejected", async () => {
    // Correct credentials → user + session cookie returned.
    const ok = await auth.api.signInEmail({
      body: { email: "salar@example.com", password: "super-secret-password" },
      returnHeaders: true,
    });
    const user = (ok as any).user ?? (ok as any).response?.user;
    expect(user.email).toBe("salar@example.com");

    // The session cookie is set.
    const setCookie = (ok as any).headers?.getSetCookie?.() ?? [];
    expect(setCookie.some((c: string) => c.includes("session"))).toBe(true);

    // Wrong password → throws an APIError.
    await expect(
      auth.api.signInEmail({
        body: { email: "salar@example.com", password: "WRONG" },
      }),
    ).rejects.toThrow();
  });

  it("a newly signed-up Merchant has emailVerified = false (verification flow exists)", async () => {
    const result = await auth.api.signUpEmail({
      body: { email: "unverified@example.com", password: "pw-12345678", name: "Unverified" },
    });
    expect((result as any).user.emailVerified).toBe(false);
  });
});

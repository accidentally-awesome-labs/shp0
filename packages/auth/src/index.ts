import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { user, session, account, verification } from "@shp0/db/schema";

/**
 * Create a better-auth instance bound to a database pool.
 *
 * Merchant identity is global (cross-Store) — NOT scoped to any Store and NOT
 * subject to RLS. The pool therefore connects as the platform role (cloud_admin),
 * which bypasses RLS. This is one of two identity domains (the per-Store Customer
 * identity comes later).
 *
 * `createAuth(pool)` is exported (not a singleton) so tests can point at a test DB.
 */
export function createAuth(pool: Pool) {
  const db = drizzle(pool);
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;


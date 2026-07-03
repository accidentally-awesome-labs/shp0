import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { user, session, account, verification } from "@shp0/db/schema";

/**
 * Create a better-auth instance bound to a database.
 *
 * Merchant identity is global (cross-Store) — NOT scoped to any Store and NOT
 * subject to RLS. The connection uses the platform role (cloud_admin), which
 * bypasses RLS. This is one of two identity domains (the per-Store Customer
 * identity comes later).
 *
 * Accepts a connection string (not a Pool) so callers don't need to import `pg`.
 */
export function createAuth(opts: { databaseUrl: string }) {
  const pool = new Pool({ connectionString: opts.databaseUrl });
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


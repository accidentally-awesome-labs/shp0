import { createAuth } from "@shp0/auth";

/**
 * The production auth singleton. Merchant identity is global (cross-Store),
 * so the connection uses the platform role (cloud_admin, bypasses RLS).
 * In prod: Neon with ?sslmode=required. Locally: shp0_test over the socket.
 */
const databaseUrl =
  process.env.PLATFORM_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql:///shp0_test?user=cloud_admin";

export const auth = createAuth({ databaseUrl });


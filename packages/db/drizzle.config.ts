import { defineConfig } from "drizzle-kit";

// Neon connection for dev/prod; local Postgres for tests.
// Dev requires ?sslmode=required per the NextFaster procedure (ADR-0001 notes).
const url =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  "postgresql:///shp0_test";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
});

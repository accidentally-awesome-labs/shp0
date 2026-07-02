import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The `stores` table — one row per Store (tenant). This is the bootstrap tenant
 * table: a Store's own row carries `store_id` equal to its own `id` (enforced by
 * a DB trigger, set up in applySchema). Every other tenant table (added in later
 * issues) will carry `store_id` stamped from the per-request GUC instead.
 */
export const stores = pgTable("stores", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;

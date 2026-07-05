import { pgTable, text, timestamp, uuid, boolean, integer, bigint } from "drizzle-orm/pg-core";

/**
 * The `stores` table — one row per Store (tenant). This is the bootstrap tenant
 * table: a Store's own row carries `store_id` equal to its own `id`. Every other
 * tenant table (added in later issues) will carry `store_id` stamped from the
 * per-request GUC instead.
 */
export const stores = pgTable("stores", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  name: text("name").notNull(),
  subdomain: text("subdomain").notNull().unique(),
  // Commission in basis points (250 = 2.5%). Platform-wide default, overridable per store.
  commissionBps: integer("commission_bps").notNull().default(250),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;

/**
 * A Product — the sellable entity a Merchant creates. Carries title, description,
 * images, and the option axes. Scoped to a Store (store_id, RLS-protected).
 */
export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  description: text("description").default("").notNull(),
  status: text("status").notNull().default("draft"), // 'draft' | 'published'
  tags: text("tags").array().default([]).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

/**
 * A Variant — the single purchasable unit. Every Product has at least one
 * Variant. Scoped to a Store (store_id, RLS-protected). Price/inventory live here.
 */
export const variants = pgTable("variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  title: text("title").notNull(),
  priceCents: bigint("price_cents", { mode: "number" }).notNull(),
  compareAtPriceCents: bigint("compare_at_price_cents", { mode: "number" }),
  inventory: integer("inventory").notNull().default(0),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Variant = typeof variants.$inferSelect;
export type NewVariant = typeof variants.$inferInsert;

/**
 * A Cart — ephemeral pre-purchase selection for an authenticated Customer.
 * One Cart per Customer per Store. Tenant-scoped (RLS-protected).
 * Per ADR-0002: holds no money, reserves no inventory.
 */
export const carts = pgTable("carts", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  customerId: text("customer_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CartRow = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;

/**
 * A line item in a Cart. References a Variant by id + quantity.
 * Tenant-scoped (RLS-protected).
 */
export const cartItems = pgTable("cart_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  cartId: uuid("cart_id")
    .notNull()
    .references(() => carts.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").notNull(),
  quantity: integer("quantity").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;

/**
 * An Order — created by checkout() from a Cart. Carries the two-dimensional
 * lifecycle (payment + fulfillment status). Tenant-scoped (RLS-protected).
 * Per ADR-0002: created in payment=pending, fulfillment=unfulfilled.
 */
export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  customerId: text("customer_id").notNull(),
  paymentStatus: text("payment_status").notNull().default("pending"),
  fulfillmentStatus: text("fulfillment_status").notNull().default("unfulfilled"),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

/**
 * An Order Line — one line in an Order. References a Variant at a quantity and
 * a snapshot of the unit price at checkout time (prices are frozen, not live).
 * Tenant-scoped (RLS-protected).
 */
export const orderLines = pgTable("order_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type OrderLine = typeof orderLines.$inferSelect;
export type NewOrderLine = typeof orderLines.$inferInsert;

/**
 * A Stripe Connect payment account linked to a Store. PLATFORM table (no RLS) —
 * bridges the Store (tenant) to Stripe's Connect account (external). Queried
 * via platformClient. One per Store.
 */
export const stripePaymentAccounts = pgTable("stripe_payment_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull().unique(),
  connectAccountId: text("connect_account_id").notNull(),
  detailsSubmitted: boolean("details_submitted").notNull().default(false),
  chargesEnabled: boolean("charges_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type StripePaymentAccount = typeof stripePaymentAccounts.$inferSelect;
export type NewStripePaymentAccount = typeof stripePaymentAccounts.$inferInsert;

/**
 * Processed webhook events — idempotency. Keyed by Stripe event id.
 * PLATFORM table (no RLS) — the webhook handler runs cross-Store (it doesn't
 * know the Store until it looks up the Connect account from the event).
 */
export const processedEvents = pgTable("processed_events", {
  id: text("id").primaryKey(), // Stripe event id (e.g. "evt_123")
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ProcessedEvent = typeof processedEvents.$inferSelect;

/**
 * A Membership links a global Merchant (user) to a Store with a Role.
 * This is a PLATFORM table (no store_id GUC, no RLS) — it bridges the global
 * identity domain (Merchants) to the tenant domain (Stores). Queried via
 * platformClient for both "which Stores does this user belong to?" (switcher)
 * and "who are the members of this Store?" (team management).
 */
export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  storeId: uuid("store_id")
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // 'owner' | 'admin' | 'staff'
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────
// better-auth core tables (PLATFORM tables — no store_id, no RLS).
// These store Merchant identity (global, cross-Store). Managed by better-auth's
// Drizzle adapter; defined here so they share one schema source + applySchema().
// ─────────────────────────────────────────────────────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

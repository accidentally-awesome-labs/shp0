import { pgTable, text, timestamp, uuid, boolean, integer, bigint, jsonb } from "drizzle-orm/pg-core";

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
  // Platform admin status: active | suspended | terminated (Issue #16).
  status: text("status").notNull().default("active"),
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
 * A Collection — a named grouping of Products. Two types:
 * - 'manual': explicit members via collection_products join table.
 * - 'automated': members derived from a rule (jsonb), evaluated at query time.
 * Scoped to a Store (store_id, RLS-protected).
 */
export const collections = pgTable("collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  type: text("type").notNull(), // 'manual' | 'automated'
  // JSON rule for automated collections. Null for manual.
  // Shape: { type: "tag", tag: string } | { type: "price_range", minCents?, maxCents? }
  rule: jsonb("rule"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;

/**
 * Manual collection members — the join table a Merchant edits.
 * Only used by manual collections. Scoped to a Store (store_id, RLS-protected).
 */
export const collectionProducts = pgTable("collection_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  collectionId: uuid("collection_id")
    .notNull()
    .references(() => collections.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CollectionProduct = typeof collectionProducts.$inferSelect;
export type NewCollectionProduct = typeof collectionProducts.$inferInsert;

/**
 * A Subscription — links a Store to a billing Tier (Issue #15).
 * PLATFORM table (no RLS) — one Store → one Tier at a time.
 * Queried via platformClient. The tier determines the commission rate.
 */
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull().unique(), // one active subscription per store
  tierId: text("tier_id").notNull(), // 'free' | 'pro' | 'scale'
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: text("status").notNull().default("active"), // 'active' | 'canceled' | 'past_due'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

/**
 * A Customer — the per-Store storefront identity (Issue #13).
 * SEPARATE from Merchant identity (which is global/cross-Store).
 * A Customer belongs to exactly ONE Store. The same email on Store A and
 * Store B are completely separate identities (no relationship).
 * Scoped to a Store (store_id, RLS-protected).
 */
export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  // scrypt hash — never the plaintext password.
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

/**
 * A Customer session — a signed-in Customer's session token.
 * Tenant-scoped (store_id, RLS-protected). A session belongs to one Customer
 * in one Store.
 */
export const customerSessions = pgTable("customer_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CustomerSession = typeof customerSessions.$inferSelect;

/**
 * A Customer address — shipping/billing address book entry.
 * Tenant-scoped (store_id, RLS-protected).
 */
export const addresses = pgTable("addresses", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  line1: text("line1").notNull(),
  line2: text("line2"),
  city: text("city").notNull(),
  region: text("region").notNull(),
  postalCode: text("postal_code").notNull(),
  country: text("country").notNull(),
  phone: text("phone"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;

/**
 * A Discount — a unified Trigger + Reward + Conditions entity (Issue #12).
 * Code-based and automatic/BOGO are the same concept.
 * Scoped to a Store (store_id, RLS-protected).
 *
 * trigger: how activated — { type: "code", code: string } | { type: "automatic" }
 * reward: what it does — jsonb matching DiscountReward from discounts.ts
 * conditions: validity window, usage limit, min spend, eligible products
 */
export const discounts = pgTable("discounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  name: text("name").notNull(),
  // Trigger jsonb: { type: "code", code: "SAVE10" } | { type: "automatic" }
  trigger: jsonb("trigger").notNull(),
  // Reward jsonb: DiscountReward (order_percent, order_fixed, line_*, free_item, free_shipping)
  reward: jsonb("reward").notNull(),
  // Conditions jsonb: { validFrom?, validUntil?, usageLimit?, minSpendCents?, eligibleProductIds? }
  conditions: jsonb("conditions"),
  usageCount: integer("usage_count").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Discount = typeof discounts.$inferSelect;
export type NewDiscount = typeof discounts.$inferInsert;

/**
 * Discount redemptions — one row per (discount, order) pair.
 * Enforces idempotency: a discount can't be redeemed twice for the same order.
 * Scoped to a Store (store_id, RLS-protected).
 */
export const discountRedemptions = pgTable("discount_redemptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull(),
  discountId: uuid("discount_id")
    .notNull()
    .references(() => discounts.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type DiscountRedemption = typeof discountRedemptions.$inferSelect;

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

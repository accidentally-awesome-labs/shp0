/**
 * Role policy for the dashboard (CONTEXT.md: Role, Owner, Admin, Staff).
 *
 * Roles are ranked Owner > Admin > Staff. A Role holds its own capabilities
 * and every lower Role's, so authorization is a rank comparison: a caller may
 * use a capability when their Role ranks at or above the capability's
 * minimum Role.
 *
 * Fails closed. memberships.role is free text with no CHECK constraint, so
 * only the exact stored strings "owner", "admin" and "staff" are Roles.
 * Anything else (a mis-cased "Owner", which also escapes the single-Owner
 * index and the owner-delete trigger, unknown text, the empty string, a
 * non-string) has rank 0 and no capability. So does an unknown capability
 * name.
 *
 * Pure and dependency-free (no I/O), so it is unit-tested without a database
 * (tests/roles.test.ts) and safe to import anywhere.
 */

/** The Roles, highest first. */
export const ROLES = ["owner", "admin", "staff"] as const;

export type Role = (typeof ROLES)[number];

const RANK: Readonly<Record<Role, number>> = { owner: 3, admin: 2, staff: 1 };

/** How a Role is written in the UI (for example "requires Owner"). */
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  owner: "Owner",
  admin: "Admin",
  staff: "Staff",
};

/**
 * Each dashboard capability and the lowest Role that has it.
 *
 * Add a capability here (and to tests/roles.test.ts) before guarding a new
 * dashboard entry point with it.
 */
export const CAPABILITY_MINIMUM_ROLE = {
  // ── Staff: view the catalog, Orders and Customers; fulfill Orders ──────
  /** Open the Store's dashboard at all (its name, Subdomain, own Role). */
  "store.view": "staff",
  /** Products (drafts included), Collections and Collection members. */
  "catalog.view": "staff",
  /** The Discounts list. */
  "discounts.view": "staff",
  /** Customers, and a Customer's Orders. */
  "customers.view": "staff",
  "orders.view": "staff",
  "orders.fulfill": "staff",

  // ── Admin: catalog, Discounts, Store settings ──────────────────────────
  /** Create and delete Products; create Collections; add and remove members. */
  "catalog.manage": "admin",
  /** Create and preview Discounts. */
  "discounts.manage": "admin",
  /** Store settings, including payouts (Stripe Connect onboarding). */
  "settings.manage": "admin",
  /** Custom Domains: list (with their TXT values), add, retry verification. */
  "domains.manage": "admin",

  // ── Owner only ─────────────────────────────────────────────────────────
  /**
   * View platform billing (Tier, Usage). CONTEXT.md reserves managing
   * platform billing to the Owner and says nothing about viewing it; Owner
   * only is an owner decision still pending.
   */
  "billing.view": "owner",
  /** Change the Store's Tier. */
  "billing.manage": "owner",
  "memberships.manage": "owner",
  "store.transfer": "owner",
  "store.delete": "owner",
} as const satisfies Readonly<Record<string, Role>>;

export type Capability = keyof typeof CAPABILITY_MINIMUM_ROLE;

/** The Role that stored role text names, or null for anything else. */
export function parseRole(raw: unknown): Role | null {
  if (typeof raw !== "string") return null;
  return Object.hasOwn(RANK, raw) ? (raw as Role) : null;
}

/** 3 for Owner, 2 for Admin, 1 for Staff, 0 for anything that is not a Role. */
export function roleRank(role: unknown): number {
  const parsed = parseRole(role);
  return parsed === null ? 0 : RANK[parsed];
}

/** Whether `role` ranks at or above `minimum`. Not a Role: never. */
export function hasAtLeastRole(role: unknown, minimum: Role): boolean {
  const rank = roleRank(role);
  return rank > 0 && rank >= RANK[minimum];
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && Object.hasOwn(CAPABILITY_MINIMUM_ROLE, value);
}

/** The lowest Role that has `capability`. */
export function minimumRole(capability: Capability): Role {
  if (!isCapability(capability)) throw new Error(`Unknown capability: ${String(capability)}`);
  return CAPABILITY_MINIMUM_ROLE[capability];
}

/**
 * Whether a Membership with `role` may use `capability`. False for anything
 * that is not a Role and for any unknown capability, whoever asks.
 */
export function can(role: unknown, capability: Capability): boolean {
  if (!isCapability(capability)) return false;
  return hasAtLeastRole(role, CAPABILITY_MINIMUM_ROLE[capability]);
}

/** A Merchant's standing in one Store for one capability. */
export type StoreAccessDecision =
  | { status: "unauthenticated" }
  /** No Membership with a valid Role, or no such Store: indistinguishable. */
  | { status: "not_member" }
  | { status: "insufficient_role"; role: Role; required: Role }
  | { status: "ok"; role: Role };

/**
 * The dashboard gate's decision, without I/O. apps/web/lib/current-store.ts
 * supplies whether the request has a valid session and the caller's
 * Membership Role in the Store (null when there is none, the Store does not
 * exist or the id is not a Store id), then acts on the result.
 *
 * Role text that is not exactly a Role counts as no Membership. An unknown
 * capability is a programming error and throws, whoever asks.
 */
export function decideStoreAccess(
  signedIn: boolean,
  role: unknown,
  capability: Capability,
): StoreAccessDecision {
  if (!isCapability(capability)) throw new Error(`Unknown capability: ${String(capability)}`);
  if (!signedIn) return { status: "unauthenticated" };
  const parsed = parseRole(role);
  if (parsed === null) return { status: "not_member" };
  if (!can(parsed, capability)) {
    return { status: "insufficient_role", role: parsed, required: minimumRole(capability) };
  }
  return { status: "ok", role: parsed };
}

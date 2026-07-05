/**
 * Platform billing (Issue #15).
 *
 * How the platform charges Merchants — separate from how Merchants collect
 * via Stripe Connect. A Store holds one Subscription to a Tier at a time.
 *
 * THE DEEP MODULE: checkUsagePolicy() — a pure function that decides whether
 * an action is allowed, capped, or an overage, given the tier's limits and
 * current usage.
 *
 * Key distinction:
 * - Free tier: HARD-CAPS usage (blocks actions that exceed limits).
 * - Paid tiers (Pro, Scale): allow OVERAGES (charged extra, not blocked).
 */

/** The usage limits a tier defines. */
export type TierLimits = {
  maxProducts: number;
  maxOrdersPerMonth: number;
  maxStaffSeats: number;
};

/** A billing tier. Platform-defined, static configuration. */
export type Tier = {
  id: "free" | "pro" | "scale";
  name: string;
  priceCents: number;       // monthly price
  commissionBps: number;    // decreases at higher tiers
  limits: TierLimits;
  hardCap: boolean;         // Free = true (blocks), Pro/Scale = false (overage)
};

/**
 * Platform-defined tiers. Commission DECREASES at higher tiers (the platform
 * takes less as merchants grow). Price increases. Limits increase.
 */
export const TIERS: Record<"free" | "pro" | "scale", Tier> = {
  free: {
    id: "free",
    name: "Free",
    priceCents: 0,
    commissionBps: 300,      // 3.0%
    limits: { maxProducts: 10, maxOrdersPerMonth: 50, maxStaffSeats: 1 },
    hardCap: true,           // blocks at limits
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceCents: 2900,        // $29/mo
    commissionBps: 200,      // 2.0%
    limits: { maxProducts: 500, maxOrdersPerMonth: 2000, maxStaffSeats: 5 },
    hardCap: false,          // overages, not blocked
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceCents: 9900,        // $99/mo
    commissionBps: 100,      // 1.0%
    limits: { maxProducts: 10000, maxOrdersPerMonth: 50000, maxStaffSeats: 20 },
    hardCap: false,          // overages, not blocked
  },
};

/** Current usage counters for a Store. */
export type Usage = {
  productCount?: number;
  orderCountThisMonth?: number;
  staffSeats?: number;
};

/** The action a Store is trying to take. */
export type UsageAction =
  | { type: "create_product" }
  | { type: "create_order" }
  | { type: "add_staff" };

/** The policy decision: can this action proceed? */
export type UsagePolicy =
  | { allowed: true; overage: boolean }
  | { allowed: false; reason: "hard_cap_exceeded"; limit: number; current: number };

/**
 * Check whether an action is allowed under the tier's usage policy.
 *
 * Free tier: HARD-CAPS (blocks when at limit).
 * Paid tiers: allow OVERAGES (action proceeds, but flagged for billing).
 *
 * Pure function — no I/O. The DB layer meters usage and calls this.
 */
export function checkUsagePolicy(opts: {
  tierId: "free" | "pro" | "scale";
  usage: Usage;
  action: UsageAction;
}): UsagePolicy {
  const tier = TIERS[opts.tierId];

  // Map the action to the relevant counter + limit.
  let current: number;
  let limit: number;
  switch (opts.action.type) {
    case "create_product":
      current = opts.usage.productCount ?? 0;
      limit = tier.limits.maxProducts;
      break;
    case "create_order":
      current = opts.usage.orderCountThisMonth ?? 0;
      limit = tier.limits.maxOrdersPerMonth;
      break;
    case "add_staff":
      current = opts.usage.staffSeats ?? 0;
      limit = tier.limits.maxStaffSeats;
      break;
  }

  // At or above the limit.
  if (current >= limit) {
    // Free tier: hard cap → block.
    if (tier.hardCap) {
      return { allowed: false, reason: "hard_cap_exceeded", limit, current };
    }
    // Paid tier: overage → allowed, but flagged.
    return { allowed: true, overage: true };
  }

  // Under the limit — normal.
  return { allowed: true, overage: false };
}

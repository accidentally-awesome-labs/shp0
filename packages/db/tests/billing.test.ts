import { describe, it, expect } from "vitest";

import { checkUsagePolicy, TIERS } from "../src/billing";

/**
 * Issue #15 — Usage policy evaluator (deep module, pure function).
 *
 * The Free Tier HARD-CAPS usage (blocks actions that exceed limits).
 * Paid tiers (Pro, Scale) allow OVERAGES (charged extra, not blocked).
 *
 * This is the single source of truth for "can this Store do this thing?"
 */
describe("Usage policy evaluator (Issue #15)", () => {
  // ── Cycle 1: tracer — Free tier, within product limit → allowed ──
  it("allows a product creation under the Free tier product limit", () => {
    const policy = checkUsagePolicy({
      tierId: "free",
      usage: { productCount: 5 },
      action: { type: "create_product" },
    });
    expect(policy.allowed).toBe(true);
  });

  // ── Cycle 2: Free tier, at product limit → BLOCKED (hard cap) ──
  it("blocks product creation when the Free tier product limit is reached (hard cap)", () => {
    const policy = checkUsagePolicy({
      tierId: "free",
      usage: { productCount: TIERS.free.limits.maxProducts }, // at the cap
      action: { type: "create_product" },
    });
    expect(policy.allowed).toBe(false);
    if (!policy.allowed) {
      expect(policy.reason).toBe("hard_cap_exceeded");
    }
  });

  // ── Cycle 3: Pro tier, above product limit → OVERAGE (not blocked) ──
  it("allows product creation above the Pro tier limit (overage, not blocked)", () => {
    const policy = checkUsagePolicy({
      tierId: "pro",
      usage: { productCount: TIERS.pro.limits.maxProducts + 10 }, // way above
      action: { type: "create_product" },
    });
    expect(policy.allowed).toBe(true); // overage, not blocked
    if (policy.allowed) {
      expect(policy.overage).toBe(true);
    }
  });

  // ── Cycle 4: commission rate decreases at higher tiers ──
  it("commission rate decreases at higher tiers (Free > Pro > Scale)", () => {
    expect(TIERS.free.commissionBps).toBeGreaterThan(TIERS.pro.commissionBps);
    expect(TIERS.pro.commissionBps).toBeGreaterThan(TIERS.scale.commissionBps);
  });

  // ── Cycle 5: order limits — Free hard-caps, Pro overages ──
  it("Free tier blocks order creation beyond the monthly order cap; Pro allows it", () => {
    // Free at cap → blocked.
    const freePolicy = checkUsagePolicy({
      tierId: "free",
      usage: { orderCountThisMonth: TIERS.free.limits.maxOrdersPerMonth },
      action: { type: "create_order" },
    });
    expect(freePolicy.allowed).toBe(false);
    if (!freePolicy.allowed) {
      expect(freePolicy.reason).toBe("hard_cap_exceeded");
    }

    // Pro at cap → allowed (overage).
    const proPolicy = checkUsagePolicy({
      tierId: "pro",
      usage: { orderCountThisMonth: TIERS.pro.limits.maxOrdersPerMonth },
      action: { type: "create_order" },
    });
    expect(proPolicy.allowed).toBe(true);
    if (proPolicy.allowed) {
      expect(proPolicy.overage).toBe(true);
    }
  });
});

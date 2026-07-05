import { describe, it, expect } from "vitest";

import { applyDiscounts } from "../src/discounts";

/**
 * Issue #12 — Discount stacking engine (deep module, pure function).
 *
 * Precedence (fixed, not configurable):
 *   1. LINE-level rewards first (percent before fixed, per line, floored at zero)
 *   2. ORDER-level rewards second (percent before fixed, applied to discounted subtotal)
 *   3. SHIPPING rewards last (free shipping zeroes it)
 *   4. Percent rounds half-up on minor units (cents)
 *
 * The engine never lets any amount go below zero.
 */
describe("Discount stacking engine (Issue #12)", () => {
  // Helper: a simple cart with one line and flat shipping.
  function cart(lines: Array<{ unitPriceCents: number; quantity: number }>, shippingCents = 0) {
    return {
      lines: lines.map((l, i) => ({
        productId: `p${i}`,
        variantId: `v${i}`,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
      })),
      shippingCents,
    };
  }

  // ── Cycle 1: tracer — single order-level fixed discount ──
  it("applies a single order-level fixed discount and subtracts from the total", () => {
    const c = cart([{ unitPriceCents: 5000, quantity: 1 }]); // $50.00
    const result = applyDiscounts(c, [
      { kind: "order_fixed", amountCents: 1000 }, // $10 off
    ]);
    expect(result.finalTotalCents).toBe(4000);
    expect(result.totalDiscountCents).toBe(1000);
  });

  // ── Cycle 2: order-level percent rounds half-up ──
  it("applies an order-level percent discount and rounds half-up", () => {
    // $99.99 = 9999 cents. 10% = 999.9 → rounds half-up to 1000.
    const c = cart([{ unitPriceCents: 9999, quantity: 1 }]);
    const result = applyDiscounts(c, [{ kind: "order_percent", percent: 10 }]);
    expect(result.orderDiscountCents).toBe(1000);
    expect(result.finalTotalCents).toBe(8999);
  });

  // ── Cycle 3: never-negative floor ──
  it("never lets a discount bring the total below zero", () => {
    const c = cart([{ unitPriceCents: 500, quantity: 1 }]); // $5.00
    const result = applyDiscounts(c, [{ kind: "order_fixed", amountCents: 9999 }]);
    expect(result.orderDiscountCents).toBe(500); // floored at subtotal
    expect(result.finalTotalCents).toBe(0);
  });

  // ── Cycle 4: line-level percent applies to specific lines ──
  it("applies a line-level percent discount only to eligible products", () => {
    const c = cart([
      { unitPriceCents: 2000, quantity: 1 }, // p0 — eligible
      { unitPriceCents: 3000, quantity: 1 }, // p1 — NOT eligible
    ]);
    const result = applyDiscounts(c, [
      { kind: "line_percent", percent: 50, productIds: ["p0"] },
    ]);
    expect(result.lineDiscountCents).toEqual([1000, 0]);
    // $50 − $10 line discount = $40 total
    expect(result.finalTotalCents).toBe(4000);
  });

  // ── Cycle 5: stacking — percent before fixed (order level) ──
  it("stacks percent before fixed at the order level", () => {
    const c = cart([{ unitPriceCents: 10000, quantity: 1 }]); // $100.00
    const result = applyDiscounts(c, [
      { kind: "order_percent", percent: 10 },  // 10% of $100 = $10 off
      { kind: "order_fixed", amountCents: 500 }, // then $5 off
    ]);
    // Percent applies first: $100 → $90. Then fixed: $90 → $85.
    expect(result.orderDiscountCents).toBe(1500);
    expect(result.finalTotalCents).toBe(8500);
  });

  // ── Cycle 6: precedence — line discounts before order discounts ──
  it("applies line-level discounts before order-level (order % on discounted base)", () => {
    const c = cart([{ unitPriceCents: 10000, quantity: 1 }]); // $100.00
    const result = applyDiscounts(c, [
      { kind: "line_percent", percent: 20 },   // $20 off the line → $80 subtotal
      { kind: "order_percent", percent: 10 },  // 10% of $80 = $8 off
    ]);
    // Line discount: $20. Order discount applies to $80 (not $100): $8.
    expect(result.lineDiscountCents).toEqual([2000]);
    expect(result.orderDiscountCents).toBe(800);
    expect(result.finalTotalCents).toBe(7200); // $100 − $20 − $8
  });

  // ── Cycle 7: free item adds a line at unit price 0 ──
  it("adds a free item (no impact on total, but tracked for inventory)", () => {
    const c = cart([{ unitPriceCents: 5000, quantity: 1 }]);
    const result = applyDiscounts(c, [
      { kind: "free_item", productId: "gift", variantId: "gift-v", quantity: 1 },
    ]);
    expect(result.freeItems).toEqual([{ productId: "gift", variantId: "gift-v", quantity: 1 }]);
    expect(result.finalTotalCents).toBe(5000); // free item doesn't change total
  });

  // ── Cycle 8: free shipping zeroes out shipping ──
  it("zeroes out shipping with free_shipping reward", () => {
    const c = cart([{ unitPriceCents: 5000, quantity: 1 }], 1500); // $50 + $15 shipping
    const result = applyDiscounts(c, [{ kind: "free_shipping" }]);
    expect(result.shippingCents).toBe(0);
    expect(result.finalTotalCents).toBe(5000); // just the item, no shipping
    expect(result.totalDiscountCents).toBe(1500); // the shipping savings
  });

  // ── Cycle 9: full chain — line% + line$ + order% + order$ + free shipping ──
  it("stacks the full chain: line%, line$, order%, order$, free shipping", () => {
    const c = cart(
      [{ unitPriceCents: 10000, quantity: 2 }], // 2 × $100 = $200 subtotal
      2000, // $20 shipping
    );
    const result = applyDiscounts(c, [
      { kind: "line_percent", percent: 10 },    // 10% off lines: $200 → $180
      { kind: "line_fixed", amountCents: 500 }, // $5 off lines: $180 → $175
      { kind: "order_percent", percent: 10 },   // 10% off $175 = $17.50 → $18 (half-up)
      { kind: "order_fixed", amountCents: 1000 }, // $10 off
      { kind: "free_shipping" },                 // $20 shipping → $0
    ]);
    // Line discounts: $25 total. Order %: 10% of $175 = $17.50 → $18. Order $: $10.
    // Total discount: $25 + $18 + $10 + $20 (shipping) = $73.
    // Final: $200 − $25 − $18 − $10 + $0 = $147.
    expect(result.finalTotalCents).toBe(14750);
  });
});

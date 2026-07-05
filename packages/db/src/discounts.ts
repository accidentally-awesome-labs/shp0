/**
 * Discount stacking engine (Issue #12).
 *
 * THE DEEP MODULE: a pure function that applies discount rewards to a cart
 * under fixed precedence rules. No I/O, no persistence — just math.
 *
 * Precedence (fixed, not configurable):
 *   1. LINE-level rewards first (percent before fixed, per line, floored at zero)
 *   2. ORDER-level rewards second (percent before fixed, applied to discounted subtotal)
 *   3. SHIPPING rewards last (free shipping zeroes it)
 *   4. Percent rounds half-up on minor units (cents)
 *
 * The engine never lets any amount go below zero.
 */

/** The cart shape the engine operates on. */
export type DiscountCart = {
  lines: Array<{
    productId: string;
    variantId: string;
    quantity: number;
    unitPriceCents: number;
  }>;
  shippingCents: number;
};

/** A discount reward ready to apply (trigger/conditions already checked). */
export type DiscountReward =
  | { kind: "order_percent"; percent: number }
  | { kind: "order_fixed"; amountCents: number }
  | { kind: "line_percent"; percent: number; productIds?: string[] }
  | { kind: "line_fixed"; amountCents: number; productIds?: string[] }
  | { kind: "free_shipping" }
  | { kind: "free_item"; variantId: string; productId: string; quantity: number };

/** The result of applying discounts. */
export type DiscountResult = {
  /** Per-line discount amounts (after all line-level rewards). */
  lineDiscountCents: number[];
  /** Total order-level discount (after all order-level rewards). */
  orderDiscountCents: number;
  /** Shipping after discount (free shipping → 0). */
  shippingCents: number;
  /** Free items added (each adds an order line at unit price 0). */
  freeItems: Array<{ productId: string; variantId: string; quantity: number }>;
  /** Grand total discount across all levels. */
  totalDiscountCents: number;
  /** Final amount payable (subtotal − discounts + shipping). */
  finalTotalCents: number;
};

/** Round half-up on cents (Math.round does banker's rounding in JS). */
function roundHalfUp(cents: number): number {
  return Math.floor(cents + 0.5);
}

/**
 * Apply discount rewards to a cart under fixed precedence.
 *
 * Pure function — no side effects, no I/O.
 */
export function applyDiscounts(
  cart: DiscountCart,
  rewards: DiscountReward[],
): DiscountResult {
  const lineTotals = cart.lines.map((l) => l.unitPriceCents * l.quantity);

  // ── 1. LINE-LEVEL rewards: percent before fixed ──
  const lineDiscounts = new Array(lineTotals.length).fill(0);

  for (const reward of rewards) {
    if (reward.kind === "line_percent") {
      for (let i = 0; i < cart.lines.length; i++) {
        const line = cart.lines[i]!;
        if (reward.productIds && !reward.productIds.includes(line.productId)) continue;
        const discount = roundHalfUp((lineTotals[i]! - lineDiscounts[i]!) * reward.percent / 100);
        // Floor at zero (can't go below zero).
        const newDiscount = Math.min(lineDiscounts[i]! + discount, lineTotals[i]!);
        lineDiscounts[i] = Math.max(0, newDiscount);
      }
    }
  }

  for (const reward of rewards) {
    if (reward.kind === "line_fixed") {
      for (let i = 0; i < cart.lines.length; i++) {
        const line = cart.lines[i]!;
        if (reward.productIds && !reward.productIds.includes(line.productId)) continue;
        const newDiscount = Math.min(lineDiscounts[i]! + reward.amountCents, lineTotals[i]!);
        lineDiscounts[i] = Math.max(0, newDiscount);
      }
    }
  }

  // ── 2. ORDER-LEVEL rewards: applied to discounted subtotal ──
  const discountedSubtotal = lineTotals.reduce((sum, t, i) => sum + (t - lineDiscounts[i]!), 0);
  let orderDiscount = 0;

  for (const reward of rewards) {
    if (reward.kind === "order_percent") {
      const discount = roundHalfUp((discountedSubtotal - orderDiscount) * reward.percent / 100);
      orderDiscount = Math.min(orderDiscount + discount, discountedSubtotal);
      orderDiscount = Math.max(0, orderDiscount);
    }
  }

  for (const reward of rewards) {
    if (reward.kind === "order_fixed") {
      orderDiscount = Math.min(orderDiscount + reward.amountCents, discountedSubtotal);
      orderDiscount = Math.max(0, orderDiscount);
    }
  }

  // ── 3. SHIPPING rewards ──
  let shipping = cart.shippingCents;
  for (const reward of rewards) {
    if (reward.kind === "free_shipping") {
      shipping = 0;
    }
  }

  // ── Free items ──
  const freeItems: Array<{ productId: string; variantId: string; quantity: number }> = [];
  for (const reward of rewards) {
    if (reward.kind === "free_item") {
      freeItems.push({ productId: reward.productId, variantId: reward.variantId, quantity: reward.quantity });
    }
  }

  const totalDiscount =
    lineDiscounts.reduce((s, d) => s + d, 0) + orderDiscount + (cart.shippingCents - shipping);
  const finalTotal = discountedSubtotal - orderDiscount + shipping;

  return {
    lineDiscountCents: lineDiscounts,
    orderDiscountCents: orderDiscount,
    shippingCents: shipping,
    freeItems,
    totalDiscountCents: totalDiscount,
    finalTotalCents: finalTotal,
  };
}

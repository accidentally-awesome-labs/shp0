/**
 * Cart domain logic (Issue #8, ADR-0002).
 *
 * A Cart is ephemeral, lightweight storage of Variant references and quantities.
 * It holds no money and reserves no inventory. Prices are computed at read time
 * from live Variant prices (not stored in the Cart) — so a price change is
 * always reflected, with no stale snapshot.
 */

/** A Cart is identified by its Store and contains zero or more lines. */
export type Cart = {
  storeId: string;
  lines: CartLine[];
};

/** A single line in a cart — a Variant reference and a quantity. */
export type CartLine = {
  variantId: string;
  quantity: number;
};

/**
 * Add a line to a cart. If the variant already exists, the quantity is summed.
 * Returns a new cart (immutable). Rejects zero/negative quantity.
 */
export function addLine(cart: Cart, line: CartLine): Cart {
  if (line.quantity <= 0) {
    throw new Error("Quantity must be positive");
  }

  const existing = cart.lines.find((l) => l.variantId === line.variantId);
  if (existing) {
    return {
      ...cart,
      lines: cart.lines.map((l) =>
        l.variantId === line.variantId
          ? { ...l, quantity: l.quantity + line.quantity }
          : l,
      ),
    };
  }

  return { ...cart, lines: [...cart.lines, line] };
}

/**
 * Update a line's quantity. If the new quantity is 0, the line is removed.
 * Rejects negative quantity. Returns a new cart (immutable).
 */
export function updateLine(
  cart: Cart,
  update: { variantId: string; quantity: number },
): Cart {
  if (update.quantity < 0) {
    throw new Error("Quantity cannot be negative");
  }

  if (update.quantity === 0) {
    return removeLine(cart, update.variantId);
  }

  return {
    ...cart,
    lines: cart.lines.map((l) =>
      l.variantId === update.variantId
        ? { ...l, quantity: update.quantity }
        : l,
    ),
  };
}

/**
 * Remove a line by variantId. No-op if the variant isn't in the cart.
 * Returns a new cart (immutable).
 */
export function removeLine(cart: Cart, variantId: string): Cart {
  return {
    ...cart,
    lines: cart.lines.filter((l) => l.variantId !== variantId),
  };
}

/**
 * Compute the subtotal (in minor units) from a cart and a price map.
 * Unknown variants (deleted/unavailable) are treated as price 0.
 *
 * Pure integer math — consistent with ADR-0004.
 */
export function computeSubtotal(
  cart: Cart,
  prices: Map<string, number>,
): number {
  return cart.lines.reduce(
    (sum, line) => sum + line.quantity * (prices.get(line.variantId) ?? 0),
    0,
  );
}

/**
 * Merge two carts (merge-on-login). Quantities for the same variant are summed.
 * Both carts must belong to the same Store. Returns a new cart.
 */
export function mergeCarts(anon: Cart, db: Cart): Cart {
  if (anon.storeId !== db.storeId) {
    throw new Error("Cannot merge carts from different Stores");
  }

  const merged = new Map<string, number>();
  for (const line of [...anon.lines, ...db.lines]) {
    merged.set(line.variantId, (merged.get(line.variantId) ?? 0) + line.quantity);
  }

  return {
    storeId: anon.storeId,
    lines: Array.from(merged.entries()).map(([variantId, quantity]) => ({
      variantId,
      quantity,
    })),
  };
}

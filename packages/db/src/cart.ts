/**
 * Cart domain logic (Issue #8, ADR-0002).
 *
 * A Cart is ephemeral, lightweight storage of Variant references and quantities.
 * It holds no money and reserves no inventory. Prices are computed at read time
 * from live Variant prices (not stored in the Cart) — so a price change is
 * always reflected, with no stale snapshot.
 *
 * A storefront Cart line is a Variant of a published Product of the Cart's
 * Store, at a whole quantity from 1 to MAX_LINE_QUANTITY. The pure half of
 * that rule lives here (the quantity, the id shape, applying a change,
 * pricing a Cart for checkout); whether a Variant is published in the Store
 * is a database question, answered in the same transaction that writes the
 * Cart (changeDbCart) or creates the Order (checkout) in index.ts.
 */

import { isUuid } from "./ids";

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

// ─────────────────────────────────────────────────────────────────────────
// Storefront Cart rules: what a shopper may put in a Cart, and what checkout
// accepts. Server actions receive untrusted input (any JSON value from any
// client), so they parse it with parseCartChange before any query.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The most units of one Variant a Cart line may hold (and so an Order Line
 * created from it). A storefront limit, not a stock level: inventory is only
 * checked and decremented in the payment transaction (ADR-0002). It keeps a
 * Cart to shopper-sized quantities, and every Order total well inside
 * integer range.
 */
export const MAX_LINE_QUANTITY = 99;

/** A Cart line quantity: a number that is a whole number from 1 to MAX_LINE_QUANTITY. */
export function isValidLineQuantity(quantity: unknown): quantity is number {
  return (
    typeof quantity === "number" &&
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= MAX_LINE_QUANTITY
  );
}

/**
 * One change a shopper makes to their Cart.
 * - add: sum `quantity` into the Variant's line (addLine);
 * - set: replace the line's quantity; 0 removes the line, and a Variant not
 *   in the Cart is left alone (updateLine);
 * - remove: drop the line (removeLine).
 */
export type CartChange =
  | { kind: "add"; variantId: string; quantity: number }
  | { kind: "set"; variantId: string; quantity: number }
  | { kind: "remove"; variantId: string };

/**
 * Why a Cart change was refused:
 * - unavailable: the id is not a Variant of a published Product of this Store
 *   (malformed, unknown, another Store's, or a draft), all alike;
 * - invalid_quantity: not a whole number from 1 to MAX_LINE_QUANTITY (0 also
 *   allowed for set);
 * - quantity_limit: the add would take the line above MAX_LINE_QUANTITY.
 */
export type CartChangeRejection = "unavailable" | "invalid_quantity" | "quantity_limit";

export type ParsedCartChange =
  | { ok: true; change: CartChange }
  | { ok: false; reason: CartChangeRejection };

export type CartChangeResult = { ok: true; cart: Cart } | { ok: false; reason: CartChangeRejection };

/**
 * Parse untrusted input into a CartChange. The Variant id must be a UUID
 * string (normalized to lowercase, the form Postgres returns, so the line
 * math matches it to an existing line); the quantity must satisfy
 * isValidLineQuantity, or be 0 for set. A string such as "2" is refused, not
 * coerced.
 */
export function parseCartChange(
  kind: CartChange["kind"],
  variantId: unknown,
  quantity?: unknown,
): ParsedCartChange {
  if (!isUuid(variantId)) return { ok: false, reason: "unavailable" };
  const id = variantId.toLowerCase();
  switch (kind) {
    case "add":
      return isValidLineQuantity(quantity)
        ? { ok: true, change: { kind, variantId: id, quantity } }
        : { ok: false, reason: "invalid_quantity" };
    case "set":
      return quantity === 0 || isValidLineQuantity(quantity)
        ? { ok: true, change: { kind, variantId: id, quantity } }
        : { ok: false, reason: "invalid_quantity" };
    case "remove":
      return { ok: true, change: { kind, variantId: id } };
    default:
      throw new Error(`Unknown cart change: ${String(kind)}`);
  }
}

/**
 * Apply a change with the pure line math (addLine, updateLine, removeLine),
 * re-checking the quantity rule and refusing an add that would take the line
 * above MAX_LINE_QUANTITY. Whether the Variant may be sold is the caller's
 * check (it needs the database).
 */
export function applyCartChange(cart: Cart, change: CartChange): CartChangeResult {
  switch (change.kind) {
    case "add": {
      if (!isValidLineQuantity(change.quantity)) return { ok: false, reason: "invalid_quantity" };
      const current = cart.lines.find((l) => l.variantId === change.variantId)?.quantity ?? 0;
      if (current + change.quantity > MAX_LINE_QUANTITY) return { ok: false, reason: "quantity_limit" };
      return { ok: true, cart: addLine(cart, { variantId: change.variantId, quantity: change.quantity }) };
    }
    case "set":
      if (change.quantity !== 0 && !isValidLineQuantity(change.quantity)) {
        return { ok: false, reason: "invalid_quantity" };
      }
      return { ok: true, cart: updateLine(cart, { variantId: change.variantId, quantity: change.quantity }) };
    case "remove":
      return { ok: true, cart: removeLine(cart, change.variantId) };
  }
}

/** What checkout needs to know about a Variant the Store can see. */
export type CheckoutVariant = { priceCents: number; published: boolean };

export type CheckoutLineProblem = {
  variantId: string;
  reason: "unavailable" | "invalid_quantity";
};

export type PricedCart =
  | {
      ok: true;
      lines: Array<{ variantId: string; quantity: number; unitPriceCents: number }>;
      totalCents: number;
    }
  | { ok: false; reason: "empty_cart" }
  | { ok: false; reason: "invalid_lines"; problems: CheckoutLineProblem[] };

/**
 * Price a Cart for checkout from the Store's live Variants, re-validating
 * every line. `variants` holds only the Variants this Store can see (RLS), so
 * another Store's Variant is simply absent.
 *
 * A line is unavailable when its Variant is absent, its Product is not
 * published, or its price is not a non-negative safe integer of minor units;
 * it has an invalid quantity when isValidLineQuantity says so. Any problem
 * refuses the WHOLE Cart, listing every problem in line order: checkout never
 * drops a line silently.
 */
export function priceCartForCheckout(
  lines: readonly CartLine[],
  variants: ReadonlyMap<string, CheckoutVariant>,
): PricedCart {
  if (lines.length === 0) return { ok: false, reason: "empty_cart" };
  const problems: CheckoutLineProblem[] = [];
  const priced: Array<{ variantId: string; quantity: number; unitPriceCents: number }> = [];
  for (const line of lines) {
    const variant = variants.get(line.variantId);
    if (
      variant === undefined ||
      !variant.published ||
      !Number.isSafeInteger(variant.priceCents) ||
      variant.priceCents < 0
    ) {
      problems.push({ variantId: line.variantId, reason: "unavailable" });
    } else if (!isValidLineQuantity(line.quantity)) {
      problems.push({ variantId: line.variantId, reason: "invalid_quantity" });
    } else {
      priced.push({ variantId: line.variantId, quantity: line.quantity, unitPriceCents: variant.priceCents });
    }
  }
  if (problems.length > 0) return { ok: false, reason: "invalid_lines", problems };
  const totalCents = priced.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  if (!Number.isSafeInteger(totalCents)) throw new Error("Order total is out of range");
  return { ok: true, lines: priced, totalCents };
}

/** Why checkout refused a Cart. */
export type CheckoutRejection = "empty_cart" | "invalid_lines";

/** The shopper-facing message for a refused Cart change. */
export function cartChangeRejectionMessage(reason: CartChangeRejection): string {
  switch (reason) {
    case "unavailable":
      return "This item is not available.";
    case "invalid_quantity":
      return `Choose a quantity from 1 to ${MAX_LINE_QUANTITY}.`;
    case "quantity_limit":
      return `Your cart can hold at most ${MAX_LINE_QUANTITY} of one item.`;
  }
}

/** The shopper-facing message for a refused checkout. */
export function checkoutRejectionMessage(reason: CheckoutRejection): string {
  switch (reason) {
    case "empty_cart":
      return "Your cart is empty.";
    case "invalid_lines":
      return "Some items in your cart are no longer available or have an invalid quantity. Update your cart and try again.";
  }
}

/**
 * Thrown by checkout() when it refuses a Cart; nothing was written. `problems`
 * lists the invalid lines for "invalid_lines".
 */
export class CheckoutError extends Error {
  readonly reason: CheckoutRejection;
  readonly problems: readonly CheckoutLineProblem[];

  constructor(reason: CheckoutRejection, problems: readonly CheckoutLineProblem[] = []) {
    super(checkoutRejectionMessage(reason));
    this.name = "CheckoutError";
    this.reason = reason;
    this.problems = problems;
  }
}

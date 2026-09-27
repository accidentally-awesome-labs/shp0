"use server";

import { newCartToken, readCartToken, setCartTokenCookie } from "@/lib/cart-token";
import { resolveStorefrontStore } from "@/lib/current-store";
import {
  cartChangeRejectionMessage,
  changeDbCart,
  getDbCart,
  parseCartChange,
  type Cart,
  type ParsedCartChange,
} from "@shp0/db";

/**
 * Storefront Cart actions. The Store is the request host's and the Cart the
 * shopper's own cart-token cookie; nothing about either comes from the
 * arguments.
 *
 * Every export is callable over HTTP with ANY arguments (any JSON value), so
 * the arguments are parsed first (parseCartChange: a UUID Variant id and a
 * whole quantity from 1 to MAX_LINE_QUANTITY, or 0 to remove), before any
 * query runs. changeDbCart then accepts only a Variant of a published Product
 * of this Store and writes the change in one transaction.
 *
 * A shopper without a cart token gets one only when an add is accepted: a
 * refused change stores nothing, so it sets no cookie either (a cookie set by
 * an action makes Next re-render the page in the response, which for an
 * unpublished Product is a not-found page instead of the message).
 *
 * A refusal is returned, not thrown: production builds replace a thrown
 * error's message with a digest, and the shopper should see why.
 */
export type CartActionResult = { ok: true } | { ok: false; error: string };

const STORE_UNAVAILABLE = "This store is not available.";

async function applyToCart(parsed: ParsedCartChange): Promise<CartActionResult> {
  if (!parsed.ok) return { ok: false, error: cartChangeRejectionMessage(parsed.reason) };
  const storeId = await resolveStorefrontStore();
  if (!storeId) return { ok: false, error: STORE_UNAVAILABLE };
  const existing = await readCartToken();
  const token = existing ?? newCartToken();
  const result = await changeDbCart(storeId, token, parsed.change);
  if (!result.ok) return { ok: false, error: cartChangeRejectionMessage(result.reason) };
  // Only an add creates a Cart; set and remove without a token change nothing.
  if (existing === null && parsed.change.kind === "add") await setCartTokenCookie(token);
  return { ok: true };
}

export async function addToCart(variantId: string, quantity: number = 1): Promise<CartActionResult> {
  return applyToCart(parseCartChange("add", variantId, quantity));
}

/** Set a line's quantity; 0 removes the line. */
export async function updateCartItem(variantId: string, quantity: number): Promise<CartActionResult> {
  return applyToCart(parseCartChange("set", variantId, quantity));
}

export async function removeCartItem(variantId: string): Promise<CartActionResult> {
  return applyToCart(parseCartChange("remove", variantId));
}

export async function getCart(): Promise<Cart> {
  const storeId = await resolveStorefrontStore();
  if (!storeId) throw new Error("No store resolved for this request");
  const token = await readCartToken();
  return token === null ? { storeId, lines: [] } : getDbCart(storeId, token);
}

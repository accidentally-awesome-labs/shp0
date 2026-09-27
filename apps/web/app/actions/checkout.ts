"use server";

import { readCartToken } from "@/lib/cart-token";
import { resolveStorefrontStore } from "@/lib/current-store";
import { checkout, CheckoutError, checkoutRejectionMessage } from "@shp0/db";

/**
 * A refusal is returned, not thrown: production builds replace a thrown
 * error's message with a digest, and the shopper should see why.
 */
export type CheckoutActionResult =
  | { ok: true; orderId: string; totalCents: number }
  | { ok: false; error: string };

/**
 * Check out the shopper's own Cart (cart-token cookie) in the request host's
 * Store. checkout() re-validates every line (a published Product of this
 * Store, a whole quantity from 1 to MAX_LINE_QUANTITY) and refuses the whole
 * Cart, writing nothing, if any line is invalid.
 */
export async function checkoutAction(): Promise<CheckoutActionResult> {
  const storeId = await resolveStorefrontStore();
  if (!storeId) return { ok: false, error: "This store is not available." };

  const token = await readCartToken();
  if (!token) return { ok: false, error: checkoutRejectionMessage("empty_cart") };

  try {
    const { orderId, totalCents } = await checkout(storeId, token);
    return { ok: true, orderId, totalCents };
  } catch (error) {
    if (error instanceof CheckoutError) {
      return { ok: false, error: checkoutRejectionMessage(error.reason) };
    }
    throw error;
  }
}

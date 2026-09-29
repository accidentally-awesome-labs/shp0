"use server";

import { readCartToken } from "@/lib/cart-token";
import { resolveStorefront } from "@/lib/current-store";
import { isUuid } from "@shp0/db";
import { startCheckout, type CheckoutOutcome } from "@shp0/payments";
import { getStripe } from "@/lib/stripe";

/** Where the Order page goes after Pay: to Stripe, or back to the Order with a note. */
export type PayResult = { kind: "stripe"; url: string } | { kind: "order"; note: "failed" | "in_progress" | null };

/**
 * Storefront Pay (ADR-0006): start Stripe Checkout for an Order of the
 * request host's Store. Only the request carrying the cart token that placed
 * the Order (its own shp0_cart_token cookie) gets a session: startCheckout
 * matches both, so another shopper's token, no token and a nonexistent Order
 * are all refused alike.
 *
 * It returns where to go, and the Pay button goes there, instead of calling
 * redirect(): Next renders a same-site redirect's target through an internal
 * request to its own origin, which does not carry the storefront's Host, so
 * the Store would not be found (a 404). The Order page works out from the
 * Order why it cannot be paid; the note only says that this Pay failed or
 * found another in progress. Stripe's return URLs are on the host that
 * served this request.
 */
export async function payOrderAction(orderId: string): Promise<PayResult> {
  const storefront = await resolveStorefront();
  if (!storefront || !isUuid(orderId)) return { kind: "order", note: null };

  let outcome: CheckoutOutcome;
  try {
    outcome = await startCheckout(
      { stripe: getStripe },
      { storeId: storefront.storeId, orderId, cartToken: await readCartToken(), origin: storefront.origin },
    );
  } catch (error) {
    // Nothing was given to the Customer; they can Pay again.
    console.error(
      `Pay failed for Order ${orderId} (Store ${storefront.storeId}):`,
      error instanceof Error ? error.message : String(error),
    );
    return { kind: "order", note: "failed" };
  }

  if (outcome.kind === "redirect") return { kind: "stripe", url: outcome.url };
  return { kind: "order", note: outcome.reason === "in_progress" ? "in_progress" : null };
}

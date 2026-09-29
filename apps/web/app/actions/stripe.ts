"use server";

import { redirect } from "next/navigation";

import { readCartToken } from "@/lib/cart-token";
import { authorizeStore, resolveStorefront } from "@/lib/current-store";
import { getPaymentAccount, isUuid } from "@shp0/db";
import { startCheckout, type CheckoutOutcome } from "@shp0/payments";
import {
  createConnectAccountAndOnboardingLink,
  createOnboardingLink,
  getStripe,
} from "@/lib/stripe";

// Payouts are Store settings: Admin and above.
export async function onboardConnectAction(storeId: string): Promise<{ url: string }> {
  const resolved = await authorizeStore(storeId, "settings.manage");

  const existing = await getPaymentAccount(resolved.storeId);
  if (existing) {
    return createOnboardingLink(existing.connectAccountId);
  }

  const { url } = await createConnectAccountAndOnboardingLink({
    storeId: resolved.storeId,
    storeName: resolved.storeId,
  });

  return { url };
}

/**
 * Storefront Pay (ADR-0006): send the Customer to Stripe Checkout for an
 * Order of the request host's Store, or back to the Order page, which works
 * out from the Order why it cannot be paid; `?checkout=` only notes a Pay
 * that failed or found another in progress. Only the request carrying the
 * cart token that placed the Order (its own shp0_cart_token cookie) gets a
 * session: startCheckout matches both, so another shopper's token, no token
 * and a nonexistent Order all read "not_found".
 *
 * Stripe's return URLs are on the host that served this request.
 */
export async function payOrderAction(orderId: string): Promise<void> {
  const storefront = await resolveStorefront();
  if (!storefront || !isUuid(orderId)) redirect("/");

  let outcome: CheckoutOutcome | { kind: "failed" };
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
    outcome = { kind: "failed" };
  }

  // redirect() throws, so it stays outside the try.
  if (outcome.kind === "redirect") redirect(outcome.url);
  if (outcome.kind === "failed") redirect(`/order/${orderId}?checkout=failed`);
  if (outcome.reason === "in_progress") redirect(`/order/${orderId}?checkout=in_progress`);
  redirect(`/order/${orderId}`);
}

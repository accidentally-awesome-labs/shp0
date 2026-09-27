"use server";

import type Stripe from "stripe";

import { readCartToken } from "@/lib/cart-token";
import { authorizeStore, resolveStorefrontStore } from "@/lib/current-store";
import {
  getPaymentAccount,
  getStoreCommissionBps,
  getOrderForCheckout,
  buildCheckoutSessionParams,
} from "@shp0/db";
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

// Storefront: pay for an Order of the request host's Store. Only the request
// carrying the cart token that placed the Order (its own shp0_cart_token
// cookie) may: getOrderForCheckout matches both in one query, so no token,
// another shopper's token and a nonexistent Order all read "Order not found".
export async function createCheckoutSessionAction(orderId: string): Promise<{ url: string }> {
  const storeId = await resolveStorefrontStore();
  if (!storeId) throw new Error("No store resolved");

  const order = await getOrderForCheckout(storeId, orderId, await readCartToken());
  if (!order) throw new Error("Order not found");
  if (order.paymentStatus !== "pending") {
    throw new Error("Order is not pending payment");
  }

  const account = await getPaymentAccount(storeId);
  if (!account || !account.chargesEnabled) {
    throw new Error("Store has not completed Stripe onboarding");
  }

  const commissionBps = await getStoreCommissionBps(storeId);

  const params = buildCheckoutSessionParams({
    order,
    commissionBps,
    connectAccountId: account.connectAccountId,
    successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/order/${order.id}`,
    cancelUrl: `${process.env.NEXT_PUBLIC_APP_URL}/checkout`,
  });

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create(
    params as Stripe.Checkout.SessionCreateParams,
    {
      stripeAccount: account.connectAccountId,
    },
  );

  return { url: session.url! };
}

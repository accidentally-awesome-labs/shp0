"use server";

import type Stripe from "stripe";

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

export async function createCheckoutSessionAction(orderId: string): Promise<{ url: string }> {
  const storeId = await resolveStorefrontStore();
  if (!storeId) throw new Error("No store resolved");

  const account = await getPaymentAccount(storeId);
  if (!account || !account.chargesEnabled) {
    throw new Error("Store has not completed Stripe onboarding");
  }

  const order = await getOrderForCheckout(storeId, orderId);
  if (!order) throw new Error("Order not found");
  if (order.paymentStatus !== "pending") {
    throw new Error("Order is not pending payment");
  }

  const commissionBps = await getStoreCommissionBps(storeId);

  const params = buildCheckoutSessionParams({
    order,
    commissionBps,
    connectAccountId: account.connectAccountId,
    successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/order/${orderId}`,
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

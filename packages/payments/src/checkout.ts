import type Stripe from "stripe";

import {
  buildCheckoutSessionParams,
  getOrderForCheckout,
  getPaymentAccount,
  getStoreCommissionBps,
} from "@shp0/db";

/** Why Pay does not send the Customer to Stripe. */
export type CheckoutBlock =
  | "not_found"
  | "not_pending"
  | "item_unavailable"
  | "out_of_stock"
  | "not_chargeable"
  | "payments_not_set_up"
  | "processing"
  | "in_progress";

export type CheckoutOutcome = { kind: "redirect"; url: string } | { kind: "blocked"; reason: CheckoutBlock };

export type CheckoutDeps = { stripe: Stripe };

export type CheckoutRequest = {
  storeId: string;
  orderId: string;
  cartToken: string | null | undefined;
  /** The storefront origin that served the request. */
  origin: string;
};

export type CheckoutAvailability = { available: true } | { available: false; reason: CheckoutBlock };

// Ported unchanged from apps/web/app/actions/stripe.ts#createCheckoutSessionAction.
export async function getCheckoutAvailability(
  request: Omit<CheckoutRequest, "origin">,
): Promise<CheckoutAvailability> {
  const order = await getOrderForCheckout(request.storeId, request.orderId, request.cartToken);
  if (!order) return { available: false, reason: "not_found" };
  if (order.paymentStatus !== "pending") return { available: false, reason: "not_pending" };
  const account = await getPaymentAccount(request.storeId);
  if (!account || !account.chargesEnabled) return { available: false, reason: "payments_not_set_up" };
  return { available: true };
}

// Ported unchanged from apps/web/app/actions/stripe.ts#createCheckoutSessionAction.
export async function startCheckout(deps: CheckoutDeps, request: CheckoutRequest): Promise<CheckoutOutcome> {
  const { storeId, orderId } = request;
  const order = await getOrderForCheckout(storeId, orderId, request.cartToken);
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
    storeId,
    order,
    commissionBps,
    connectAccountId: account.connectAccountId,
    successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/order/${order.id}`,
    cancelUrl: `${process.env.NEXT_PUBLIC_APP_URL}/checkout`,
  });

  const session = await deps.stripe.checkout.sessions.create(params as Stripe.Checkout.SessionCreateParams, {
    stripeAccount: account.connectAccountId,
  });

  return { kind: "redirect", url: session.url! };
}

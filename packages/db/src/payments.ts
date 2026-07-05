/**
 * Payment helpers (Issue #10).
 *
 * Pure functions for fee computation and Stripe Checkout Session param
 * building. No I/O, no Stripe SDK calls — those live in the web layer.
 *
 * Per ADR-0004: all money is integer minor units (cents).
 */

/** Maximum commission is 100% (10000 basis points). */
const MAX_BPS = 10000;

/**
 * Compute the platform application fee from basis points.
 *
 * Basis points: 250 bps = 2.5%. The fee is floored to the nearest cent
 * (never overcharges the platform fee — the merchant keeps the rounding).
 *
 * Pure integer math — consistent with ADR-0004.
 */
export function computeApplicationFee(
  totalCents: number,
  commissionBps: number,
): number {
  if (commissionBps < 0) {
    throw new Error("Commission basis points cannot be negative");
  }
  if (commissionBps > MAX_BPS) {
    throw new Error("Commission basis points cannot exceed 10000 (100%)");
  }

  return Math.floor((totalCents * commissionBps) / MAX_BPS);
}

/** A line in an order, with enough info to build a Stripe line_item. */
type OrderLineForStripe = {
  variantId: string;
  productTitle: string;
  quantity: number;
  unitPriceCents: number;
};

/** The order shape needed by buildCheckoutSessionParams. */
type OrderForStripe = {
  id: string;
  totalCents: number;
  lines: OrderLineForStripe[];
};

/** The Stripe Checkout Session params (a subset — enough for our use). */
export type CheckoutSessionParams = {
  mode: "payment";
  line_items: Array<{
    quantity: number;
    price_data: {
      currency: string;
      unit_amount: number;
      product_data: { name: string };
    };
  }>;
  success_url: string;
  cancel_url: string;
  payment_intent_data: {
    application_fee_amount: number;
    transfer_data: { destination: string };
  };
  application_fee_amount: number;
  metadata: { orderId: string };
};

/**
 * Build the Stripe Checkout Session params from an Order.
 *
 * - One line_item per order line (variant).
 * - application_fee_amount computed from the commission basis points.
 * - transfer_data.destination routes the payment to the Store's Connect account.
 * - metadata.orderId lets the webhook reconcile the payment to our Order.
 *
 * This is a pure function — it does NOT call the Stripe API.
 */
export function buildCheckoutSessionParams(opts: {
  order: OrderForStripe;
  commissionBps: number;
  connectAccountId: string;
  successUrl: string;
  cancelUrl: string;
}): CheckoutSessionParams {
  const applicationFee = computeApplicationFee(opts.order.totalCents, opts.commissionBps);

  return {
    mode: "payment",
    line_items: opts.order.lines.map((line) => ({
      quantity: line.quantity,
      price_data: {
        currency: "usd",
        unit_amount: line.unitPriceCents,
        product_data: { name: line.productTitle },
      },
    })),
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    application_fee_amount: applicationFee,
    payment_intent_data: {
      application_fee_amount: applicationFee,
      transfer_data: { destination: opts.connectAccountId },
    },
    metadata: { orderId: opts.order.id },
  };
}

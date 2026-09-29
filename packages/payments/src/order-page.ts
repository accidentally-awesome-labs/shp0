import type { PaymentRecordStatus, RefundReason } from "@shp0/db";

import type { CheckoutAvailability, CheckoutBlock } from "./checkout";

/** What the Order page tells the Customer about paying the Order. */
export type OrderPaymentNotice =
  /** The Order is paid. */
  | "paid"
  /** The current session's payment was refunded automatically. */
  | "refunded"
  /** The current session's payment is being refunded automatically. */
  | "refund_pending"
  /** Stripe refused the automatic refund: the Store must refund it. */
  | "refund_failed"
  /** Back from Stripe; the payment is being confirmed. */
  | "confirming"
  /** A payment is being processed (e.g. a delayed payment method). */
  | "processing"
  /** A Pay a moment ago could not open Stripe; it can be tried again. */
  | "failed"
  /** A Pay a moment ago found another one opening Stripe. */
  | "in_progress"
  | "item_unavailable"
  | "out_of_stock"
  | "not_chargeable"
  | "payments_not_set_up";

export type OrderPaymentView = {
  notice: OrderPaymentNotice | null;
  /** Show the Pay button. */
  payable: boolean;
  /** Offer to check again: a payment is being processed. */
  refresh: boolean;
};

/** Reasons the Order cannot be paid that the page explains as they are. */
const BLOCK_NOTICES: Partial<Record<CheckoutBlock, OrderPaymentNotice>> = {
  item_unavailable: "item_unavailable",
  out_of_stock: "out_of_stock",
  not_chargeable: "not_chargeable",
  payments_not_set_up: "payments_not_set_up",
  refund_pending: "refund_pending",
};

/**
 * What the Order page says about paying, and whether it offers Pay
 * (ADR-0006). The state comes from the Order, the Payment of its current
 * Checkout Session (StorefrontOrder.payment) and getCheckoutAvailability.
 * `note` is the page's `?checkout=`, which anyone can put in a URL: it only
 * adds what happened a moment ago ("returned" from Stripe, a Pay that
 * "failed" or found one "in_progress") and never overrides the state.
 *
 * `availability` is null when it could not be read (Stripe unreachable):
 * Pay is offered, and checks again.
 */
export function describeOrderPayment(
  order: {
    paymentStatus: string;
    payment: { status: PaymentRecordStatus; refundReason: RefundReason | null } | null;
  },
  availability: CheckoutAvailability | null,
  note: string | null,
): OrderPaymentView {
  if (order.paymentStatus === "paid") return view("paid", false);
  if (order.paymentStatus !== "pending") return view(null, false);

  const reason = availability && !availability.available ? availability.reason : null;
  const payable = reason === null;

  // The current session's payment was not honoured.
  if (order.payment?.status === "refund_failed") return view("refund_failed", false);
  if (order.payment?.status === "refund_due") return view("refund_pending", false);
  if (order.payment?.status === "refunded") return view("refunded", payable);

  if (reason === "processing") return view(note === "returned" ? "confirming" : "processing", false, true);
  if (reason !== null) return view(BLOCK_NOTICES[reason] ?? null, false);
  if (note === "failed" || note === "in_progress") return view(note, true);
  return view(null, true);
}

function view(notice: OrderPaymentNotice | null, payable: boolean, refresh = false): OrderPaymentView {
  return { notice, payable, refresh };
}

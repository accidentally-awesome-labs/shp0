import { describe, it, expect } from "vitest";

import { describeOrderPayment, type CheckoutAvailability, type OrderPaymentView } from "../src/index";

/**
 * What the Order page tells the Customer about paying, and whether it offers
 * Pay (ADR-0006). The state comes from the Order, its current session's
 * Payment and getCheckoutAvailability; `?checkout=` only adds a note about a
 * moment ago and never overrides that state.
 */

type Order = Parameters<typeof describeOrderPayment>[0];

const pending: Order = { paymentStatus: "pending", payment: null };
const available: CheckoutAvailability = { available: true };
const blocked = (reason: Extract<CheckoutAvailability, { available: false }>["reason"]): CheckoutAvailability => ({
  available: false,
  reason,
});
const withPayment = (status: "refund_due" | "refunded" | "refund_failed"): Order => ({
  paymentStatus: "pending",
  payment: { status, refundReason: "insufficient_inventory" },
});

const view = (notice: OrderPaymentView["notice"], payable: boolean, refresh = false): OrderPaymentView => ({
  notice,
  payable,
  refresh,
});

describe("describeOrderPayment", () => {
  it.each<[string, Order, CheckoutAvailability | null, string | null, OrderPaymentView]>([
    ["paid", { paymentStatus: "paid", payment: { status: "paid", refundReason: null } }, null, null, view("paid", false)],
    ["voided", { paymentStatus: "voided", payment: null }, null, null, view(null, false)],
    ["payable", pending, available, null, view(null, true)],
    ["payable, after a Pay that failed", pending, available, "failed", view("failed", true)],
    ["payable, after a Pay that found another in progress", pending, available, "in_progress", view("in_progress", true)],
    // A delayed payment failed after the Customer came back: the stale note is ignored.
    ["payable, with a stale 'returned' note", pending, available, "returned", view(null, true)],
    ["payable, with a stale 'processing' note", pending, available, "processing", view(null, true)],
    ["back from Stripe, payment not recorded yet", pending, blocked("processing"), "returned", view("confirming", false, true)],
    ["payment processing", pending, blocked("processing"), null, view("processing", false, true)],
    ["payment refunded, can pay again", withPayment("refunded"), available, null, view("refunded", true)],
    ["payment refunded, still sold out", withPayment("refunded"), blocked("out_of_stock"), null, view("refunded", false)],
    ["refund owed", withPayment("refund_due"), blocked("refund_pending"), null, view("refund_pending", false)],
    ["refund failed", withPayment("refund_failed"), blocked("refund_pending"), "returned", view("refund_failed", false)],
    ["sold out", pending, blocked("out_of_stock"), null, view("out_of_stock", false)],
    ["an item deleted", pending, blocked("item_unavailable"), null, view("item_unavailable", false)],
    ["not chargeable", pending, blocked("not_chargeable"), "failed", view("not_chargeable", false)],
    ["no Stripe account", pending, blocked("payments_not_set_up"), null, view("payments_not_set_up", false)],
    // Stripe could not be asked: offer Pay, which checks again.
    ["availability unknown", pending, null, null, view(null, true)],
  ])("%s", (_name, order, availability, note, expected) => {
    expect(describeOrderPayment(order, availability, note)).toEqual(expected);
  });
});

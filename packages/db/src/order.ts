/**
 * Order lifecycle as two independent state machines (Issue #9, glossary).
 *
 * An Order has two independent axes:
 * - Payment status:    pending → {paid, voided, cancelled}; paid → refunded
 * - Fulfillment status: unfulfilled → {fulfilled}
 *
 * The overall Order state (open vs closed) is DERIVED: an Order is open while
 * either axis is non-terminal, and closed only when both are terminal.
 *
 * These functions are pure — no DB, no I/O. The DB-backed checkout and status
 * updates are separate functions in index.ts that call these for validation.
 */

export type PaymentStatus = "pending" | "paid" | "voided" | "cancelled" | "refunded";
export type FulfillmentStatus = "unfulfilled" | "fulfilled";

/** Terminal states — no outgoing transitions allowed. */
const TERMINAL_PAYMENT = new Set<PaymentStatus>(["paid", "voided", "cancelled", "refunded"]);
const TERMINAL_FULFILLMENT = new Set<FulfillmentStatus>(["fulfilled"]);

/** Allowed transitions for the payment axis. */
const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ["paid", "voided", "cancelled"],
  paid: ["refunded"],
  voided: [],
  cancelled: [],
  refunded: [],
};

/** Allowed transitions for the fulfillment axis. */
const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  unfulfilled: ["fulfilled"],
  fulfilled: [],
};

/**
 * Transition the payment status. Returns the new status, or throws if the
 * transition is invalid (no outgoing transitions from this state, or the
 * specific target is not allowed).
 */
export function transitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): PaymentStatus {
  const allowed = PAYMENT_TRANSITIONS[from];
  if (!allowed || allowed.length === 0) {
    throw new Error(`No outgoing payment transitions from "${from}"`);
  }
  if (!allowed.includes(to)) {
    throw new Error(`Invalid payment transition: ${from} → ${to}`);
  }

  return to;
}

/**
 * Transition the fulfillment status. Returns the new status, or throws if the
 * transition is invalid (no outgoing transitions, or the target not allowed).
 */
export function transitionFulfillment(
  from: FulfillmentStatus,
  to: FulfillmentStatus,
): FulfillmentStatus {
  const allowed = FULFILLMENT_TRANSITIONS[from];
  if (!allowed || allowed.length === 0) {
    throw new Error(`No outgoing fulfillment transitions from "${from}"`);
  }
  if (!allowed.includes(to)) {
    throw new Error(`Invalid fulfillment transition: ${from} → ${to}`);
  }

  return to;
}

/**
 * Derive whether an Order is open. An Order is open while either axis is
 * non-terminal, and closed only when both are terminal.
 */
export function isOrderOpen(state: {
  payment: PaymentStatus;
  fulfillment: FulfillmentStatus;
}): boolean {
  return !TERMINAL_PAYMENT.has(state.payment) || !TERMINAL_FULFILLMENT.has(state.fulfillment);
}

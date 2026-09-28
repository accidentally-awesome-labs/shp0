import Stripe from "stripe";

import {
  getStoreIdByConnectAccount,
  isEventProcessed,
  isUuid,
  markEventProcessed,
  markPaymentRefunded,
  markPaymentRefundFailed,
  recordStripePayment,
  type RefundReason,
} from "@shp0/db";

/** What the webhook route answers Stripe with. */
export type WebhookResponse = { status: number; body: Record<string, unknown> };

export type WebhookDeps = {
  /** Stripe API client (signature verification and refunds). */
  stripe: Stripe;
  /** The webhook endpoint's signing secret. */
  webhookSecret: string;
  /** Whether the configured Stripe key is a live-mode key (isLiveKey). */
  livemode: boolean;
};

/** The events the Connect endpoint is subscribed to (ADR-0006). */
const HANDLED_EVENTS = new Set<string>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

/** Whether a Stripe secret or restricted key is a live-mode key. */
export function isLiveKey(key: string): boolean {
  return key.startsWith("sk_live_") || key.startsWith("rk_live_");
}

/**
 * The Stripe webhook (ADR-0006). Payments are direct charges on each Store's
 * own Stripe account, so their events arrive on the Connect endpoint with
 * `account` set to that account.
 *
 * - A request whose signature does not verify is answered 400.
 * - Anything that is not shp0's is answered 200 and changes nothing: the
 *   other mode (livemode), an event type the endpoint does not handle, no
 *   account or an account that is no Store's, a session without shp0's
 *   metadata or naming another Store than the account's.
 * - A session pays its Order only when its payment_status is `paid`, on
 *   checkout.session.completed or checkout.session.async_payment_succeeded.
 *   recordStripePayment records the Payment and pays the Order in one
 *   transaction; a Payment it cannot honour is recorded `refund_due`, then
 *   refunded in full, on the Store's account, each attempt with its own
 *   idempotency key `refund:<PaymentIntent id>:<attempt>`. A refund Stripe
 *   refuses for good is recorded `refund_failed`, for a person to refund by
 *   hand.
 * - Only a failure a retry can fix (the database or Stripe unavailable, a
 *   rate limit, a refund request that failed that way) is answered 500, so
 *   Stripe delivers the event again. The event is marked processed only once
 *   everything it caused is done.
 * - Logs name the event id, type and account and why, never the event's
 *   object: on a Merchant-owned account, events of other integrations carry
 *   other businesses' Customers.
 */
export async function handleStripeWebhook(
  payload: string,
  signature: string | null,
  deps: WebhookDeps,
): Promise<WebhookResponse> {
  if (!signature) {
    return { status: 400, body: { error: "Missing signature" } };
  }

  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(payload, signature, deps.webhookSecret);
  } catch {
    return { status: 400, body: { error: "Invalid signature" } };
  }

  try {
    return await handleEvent(event, deps);
  } catch (error) {
    console.error(
      `Stripe event ${event.id} (${event.type}, account ${event.account ?? "none"}) failed; Stripe will deliver it again:`,
      error instanceof Error ? error.message : String(error),
    );
    return { status: 500, body: { error: "Processing failed" } };
  }
}

async function handleEvent(event: Stripe.Event, deps: WebhookDeps): Promise<WebhookResponse> {
  if (event.livemode !== deps.livemode) return ignored(event, "livemode differs from the configured key");
  if (!HANDLED_EVENTS.has(event.type)) return ignored(event, "event type not handled");
  if (await isEventProcessed(event.id)) return { status: 200, body: { received: true, replayed: true } };

  const account = event.account;
  if (!account) return ignored(event, "not a connected-account event");
  const storeId = await getStoreIdByConnectAccount(account);
  if (!storeId) return ignored(event, "account is no Store's");

  const session = event.data.object as Stripe.Checkout.Session;
  const orderId = session.metadata?.shp0_order_id;
  if (!isUuid(orderId) || session.metadata?.shp0_store_id !== storeId) {
    return ignored(event, "session is not one of this Store's Orders");
  }

  // A delayed payment method completes the session unpaid, and then succeeds
  // or fails; neither `unpaid` nor a failure moves the Order.
  if (event.type === "checkout.session.async_payment_failed" || session.payment_status !== "paid") {
    await markEventProcessed(event.id);
    return { status: 200, body: { received: true, paid: false } };
  }

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!paymentIntentId || session.amount_total === null) {
    return ignored(event, "paid session without a PaymentIntent or amount");
  }

  const outcome = await recordStripePayment(storeId, {
    orderId,
    stripeAccountId: account,
    paymentIntentId,
    checkoutSessionId: session.id,
    amountCents: session.amount_total,
    currency: session.currency ?? "",
  });
  if (outcome.action === "refund") {
    const refund = await refundInFull(deps.stripe, {
      account,
      paymentIntentId,
      storeId,
      orderId,
      reason: outcome.reason,
      attempt: outcome.attempt,
    });
    if (refund.refused) {
      console.error(
        `Stripe refused to refund ${paymentIntentId} (Store ${storeId}, Order ${orderId}): ${refund.code}; it must be refunded by hand`,
      );
      await markPaymentRefundFailed(storeId, paymentIntentId, refund.code);
    } else {
      await markPaymentRefunded(storeId, paymentIntentId, refund.refund);
    }
  }

  await markEventProcessed(event.id);
  return { status: 200, body: { received: true } };
}

/**
 * Refund a PaymentIntent in full, on the Store's account. The request carries
 * no amount, so Stripe refunds whatever is still refundable.
 *
 * Each attempt has its own idempotency key, `refund:<PaymentIntent id>:<n>`.
 * Stripe keeps a key's first result, even an error, for at least 24 hours,
 * so a retry under the same key would only get the same failure back. A new
 * key per attempt is safe because a full refund cannot be made twice: once
 * the charge is refunded, Stripe answers charge_already_refunded, which
 * counts as done (refund null).
 *
 * Throws, so the event is answered 500 and delivered again, for failures a
 * retry can fix: no answer from Stripe, Stripe unavailable (5xx), a rate
 * limit (429), a key already in use (409) or a rejected API key (401, a
 * configuration fix). Any other refusal is permanent and returned.
 */
async function refundInFull(
  stripe: Stripe,
  refund: {
    account: string;
    paymentIntentId: string;
    storeId: string;
    orderId: string;
    reason: RefundReason;
    attempt: number;
  },
): Promise<
  { refused: false; refund: { id: string; status: string | null } | null } | { refused: true; code: string }
> {
  try {
    const created = await stripe.refunds.create(
      {
        payment_intent: refund.paymentIntentId,
        metadata: { shp0_store_id: refund.storeId, shp0_order_id: refund.orderId, shp0_reason: refund.reason },
      },
      { stripeAccount: refund.account, idempotencyKey: `refund:${refund.paymentIntentId}:${refund.attempt}` },
    );
    if (created.status === "failed" || created.status === "canceled") {
      return { refused: true, code: `refund_${created.status}` };
    }
    return { refused: false, refund: { id: created.id, status: created.status } };
  } catch (error) {
    if (!(error instanceof Stripe.errors.StripeError)) throw error;
    if (error.code === "charge_already_refunded") return { refused: false, refund: null };
    const status = error.statusCode;
    const retryable =
      status === undefined || status >= 500 || status === 429 || status === 409 || status === 401;
    if (retryable) throw error;
    return { refused: true, code: error.code ?? error.type };
  }
}

function ignored(event: Stripe.Event, why: string): WebhookResponse {
  console.warn(`Stripe event ${event.id} (${event.type}, account ${event.account ?? "none"}) ignored: ${why}`);
  return { status: 200, body: { received: true, ignored: why } };
}

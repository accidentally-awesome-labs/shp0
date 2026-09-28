import type Stripe from "stripe";

import {
  getStoreIdByConnectAccount,
  isEventProcessed,
  markEventProcessed,
  markOrderPaid,
} from "@shp0/db";

/** What the webhook route answers Stripe with. */
export type WebhookResponse = { status: number; body: Record<string, unknown> };

export type WebhookDeps = {
  /** Stripe API client (signature verification and refunds). */
  stripe: Stripe;
  /** The webhook endpoint's signing secret. */
  webhookSecret: string;
  /** Whether the configured Stripe key is a live-mode key. */
  livemode: boolean;
};

/**
 * Stripe webhook handler (Issue #10).
 *
 * Flow:
 * 1. Verify signature (Stripe-constructed, crypto-verified).
 * 2. Idempotency check — if event already processed, return 200 (no-op).
 * 3. For checkout.session.completed: extract shp0_order_id from metadata,
 *    resolve the Store from the Connect account, run markOrderPaid().
 * 4. Mark event as processed.
 *
 * Signature verification + idempotency are the two correctness properties.
 */
export async function handleStripeWebhook(
  payload: string,
  signature: string | null,
  deps: WebhookDeps,
): Promise<WebhookResponse> {
  if (!signature) {
    return { status: 400, body: { error: "Missing signature or webhook secret" } };
  }

  // 1. Verify signature.
  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(payload, signature, deps.webhookSecret);
  } catch {
    return { status: 400, body: { error: "Invalid signature" } };
  }

  // 2. Idempotency — if already processed, return 200 (replay is a no-op).
  if (await isEventProcessed(event.id)) {
    return { status: 200, body: { received: true, replayed: true } };
  }

  // 3. Handle the event.
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.shp0_order_id;
    if (!orderId) {
      return { status: 400, body: { error: "No shp0_order_id in session metadata" } };
    }

    // Resolve the Store from the Connect account id.
    const connectAccountId = event.account;
    if (!connectAccountId) {
      return { status: 400, body: { error: "No Connect account on event" } };
    }

    const storeRow = await getStoreIdByConnectAccount(connectAccountId);

    if (!storeRow) {
      return { status: 400, body: { error: "Unknown Connect account" } };
    }

    // THE CONCURRENCY FENCE: markOrderPaid decrements inventory under a row-lock.
    const result = await markOrderPaid(storeRow, orderId);
    if (!result.ok && result.reason === "insufficient_inventory") {
      // Payment succeeded at Stripe but inventory ran out — void the payment.
      // (In production: initiate a refund here. For now, log and leave pending.)
      console.error(
        `Oversell prevented for order ${orderId} — payment should be refunded`,
      );
    }
  }

  // 4. Mark event as processed.
  await markEventProcessed(event.id);

  return { status: 200, body: { received: true } };
}

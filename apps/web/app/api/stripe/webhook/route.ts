import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

import {
  isEventProcessed,
  markEventProcessed,
  markOrderPaid,
  getStoreIdByConnectAccount,
} from "@shp0/db";

export const instant = false;

/**
 * Stripe webhook handler (Issue #10).
 *
 * Flow:
 * 1. Verify signature (Stripe-constructed, crypto-verified).
 * 2. Idempotency check — if event already processed, return 200 (no-op).
 * 3. For checkout.session.completed: extract orderId from metadata,
 *    resolve the Store from the Connect account, run markOrderPaid().
 * 4. Mark event as processed.
 *
 * Signature verification + idempotency are the two correctness properties.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json(
      { error: "Missing signature or webhook secret" },
      { status: 400 },
    );
  }

  // 1. Verify signature.
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2026-06-24.dahlia",
  });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // 2. Idempotency — if already processed, return 200 (replay is a no-op).
  if (await isEventProcessed(event.id)) {
    return NextResponse.json({ received: true, replayed: true });
  }

  // 3. Handle the event.
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.orderId;
    if (!orderId) {
      return NextResponse.json(
        { error: "No orderId in session metadata" },
        { status: 400 },
      );
    }

    // Resolve the Store from the Connect account id.
    const connectAccountId = event.account;
    if (!connectAccountId) {
      return NextResponse.json(
        { error: "No Connect account on event" },
        { status: 400 },
      );
    }

    const storeRow = await getStoreIdByConnectAccount(connectAccountId);

    if (!storeRow) {
      return NextResponse.json(
        { error: "Unknown Connect account" },
        { status: 400 },
      );
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

  return NextResponse.json({ received: true });
}

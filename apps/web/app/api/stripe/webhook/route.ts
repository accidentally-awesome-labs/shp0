import { NextRequest, NextResponse } from "next/server";

import { handleStripeWebhook, isLiveKey } from "@shp0/payments";
import { getStripe } from "@/lib/stripe";

export const instant = false;

/**
 * Stripe webhook: the Connect endpoint for payments on Stores' own Stripe
 * accounts (ADR-0006). The handling lives in @shp0/payments, where it is
 * tested; this route passes the raw body, the signature and the configured
 * mode.
 */
export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!webhookSecret || !secretKey) {
    console.error("Stripe webhook: STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY is not set");
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 500 });
  }
  const { status, body } = await handleStripeWebhook(
    await req.text(),
    req.headers.get("stripe-signature"),
    { stripe: getStripe(), webhookSecret, livemode: isLiveKey(secretKey) },
  );
  return NextResponse.json(body, { status });
}

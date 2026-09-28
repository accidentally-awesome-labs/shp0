import { NextRequest, NextResponse } from "next/server";

import { handleStripeWebhook } from "@shp0/payments";
import { getStripe } from "@/lib/stripe";

export const instant = false;

/**
 * Stripe webhook endpoint (Issue #10). The handling lives in @shp0/payments,
 * where it is tested; this route only passes the raw body and the signature.
 */
export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "Missing signature or webhook secret" }, { status: 400 });
  }
  const { status, body } = await handleStripeWebhook(
    await req.text(),
    req.headers.get("stripe-signature"),
    { stripe: getStripe(), webhookSecret, livemode: false },
  );
  return NextResponse.json(body, { status });
}

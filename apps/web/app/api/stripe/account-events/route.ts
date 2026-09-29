import { NextRequest, NextResponse } from "next/server";

import { handleStripeAccountEvent, isLiveKey } from "@shp0/payments";
import { getStripe } from "@/lib/stripe";

export const instant = false;

/**
 * Stripe's thin events about Stores' Stripe accounts (Accounts v2,
 * ADR-0006): a destination of its own, with its own signing secret. Each
 * event only makes shp0 read the account from Stripe again. The handling
 * lives in @shp0/payments, where it is tested.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_ACCOUNT_EVENTS_SECRET;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secret || !secretKey || secret === process.env.STRIPE_WEBHOOK_SECRET) {
    console.error(
      "Stripe account events: STRIPE_ACCOUNT_EVENTS_SECRET or STRIPE_SECRET_KEY is not set, or the secret is the v1 webhook's",
    );
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 500 });
  }
  const { status, body } = await handleStripeAccountEvent(await req.text(), req.headers.get("stripe-signature"), {
    stripe: getStripe(),
    secret,
    livemode: isLiveKey(secretKey),
  });
  return NextResponse.json(body, { status });
}

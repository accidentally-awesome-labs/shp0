import type Stripe from "stripe";

import { handleStripeWebhook, type WebhookResponse } from "./webhook";

export type AccountEventDeps = { stripe: Stripe; secret: string; livemode: boolean };

// Today Stripe's only endpoint is the v1 webhook: an account event would be handled (and refused) there.
export async function handleStripeAccountEvent(
  payload: string,
  signature: string | null,
  deps: AccountEventDeps,
): Promise<WebhookResponse> {
  return handleStripeWebhook(payload, signature, { stripe: deps.stripe, webhookSecret: deps.secret, livemode: deps.livemode });
}

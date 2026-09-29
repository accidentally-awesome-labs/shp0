import { Agent } from "node:https";
import Stripe from "stripe";

/**
 * Stripe server-side singleton (Issue #10).
 * Lazily created so the app builds without STRIPE_SECRET_KEY set. The Stripe
 * logic itself (Pay, the webhooks, a Store's Stripe account) lives in
 * @shp0/payments, where it is tested.
 */
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-06-24.dahlia",
      // A request's own timeout starts only once connected; the socket
      // timeout also bounds connecting (Pay and the Order page wait on it).
      httpAgent: new Agent({ keepAlive: true, timeout: 20_000 }),
    });
  }
  return _stripe;
}

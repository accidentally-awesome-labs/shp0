import Stripe from "stripe";

import { startStripeAccountRead } from "@shp0/db";

import { describeFailure, readAccount, stripeFailure } from "./stripe-account";
import type { WebhookResponse } from "./webhook";

export type AccountEventDeps = {
  /** Stripe API client (verification, and the read of the account). */
  stripe: Stripe;
  /** The thin event destination's signing secret (not the v1 webhook's). */
  secret: string;
  /** Whether the configured Stripe key is a live-mode key (isLiveKey). */
  livemode: boolean;
};

/** The account events the thin destination is subscribed to (ADR-0006). */
export const ACCOUNT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "v2.core.account[configuration.merchant].capability_status_updated",
  "v2.core.account[configuration.merchant].updated",
  "v2.core.account[requirements].updated",
  "v2.core.account.updated",
  "v2.core.account.closed",
]);

const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,64}$/;
const EVENT_READ = { timeout: 8_000, maxNetworkRetries: 0 };

/**
 * Stripe's thin events about Accounts v2 accounts (ADR-0006 points 2 and 4),
 * on their own route and secret.
 *
 * - A request whose signature does not verify is answered 400.
 * - Anything else that is not about a Store's account is answered 200 and
 *   changes nothing: not a thin event (a v1 event), the other mode, an event
 *   type not subscribed to, no account, or an account that is no Store's.
 * - An event about a Store's account only makes shp0 read the account from
 *   Stripe again, as the platform, and record what Stripe reports: the
 *   event's body (changes, context, the related object's url) is never used,
 *   so a redelivery or a replay only reads again, and no processed_events
 *   record is kept. An account Stripe no longer has is recorded as unable.
 * - Only a failure a retry can fix (Stripe or the database unavailable, a
 *   rate limit, the platform key refused) is answered 500, so Stripe
 *   delivers it again; another refusal is logged and answered 200.
 * - Logs name the event id, type and account, never its body.
 */
export async function handleStripeAccountEvent(
  payload: string,
  signature: string | null,
  deps: AccountEventDeps,
): Promise<WebhookResponse> {
  if (!signature) return { status: 400, body: { error: "Missing signature" } };

  let notification: { id: string; type: string; livemode: boolean; related_object?: { id?: unknown } | null };
  try {
    notification = deps.stripe.parseEventNotification(payload, signature, deps.secret) as typeof notification;
  } catch (error) {
    if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
      return { status: 400, body: { error: "Invalid signature" } };
    }
    // Signed with this destination's secret, but not a thin event notification.
    console.warn("Stripe account event ignored: not a thin event notification");
    return { status: 200, body: { received: true, ignored: "not a thin event notification" } };
  }

  const relatedId = notification.related_object?.id;
  const accountId = typeof relatedId === "string" ? relatedId : null;
  const ignored = (why: string): WebhookResponse => {
    console.warn(
      `Stripe account event ${notification.id} (${notification.type}, account ${accountId ?? "none"}) ignored: ${why}`,
    );
    return { status: 200, body: { received: true, ignored: why } };
  };

  if (notification.livemode !== deps.livemode) return ignored("livemode differs from the configured key");
  if (!ACCOUNT_EVENT_TYPES.has(notification.type)) return ignored("event type not handled");
  if (accountId === null || !STRIPE_ACCOUNT_ID.test(accountId)) return ignored("no Stripe account");

  try {
    const read = await startStripeAccountRead({ accountId });
    if (!read) return ignored("account is no Store's");
    await readAccount(deps.stripe, read, EVENT_READ);
    return { status: 200, body: { received: true } };
  } catch (error) {
    const failure = stripeFailure(error);
    const what = `Stripe account event ${notification.id} (${notification.type}, account ${accountId})`;
    if (failure === "refused") {
      console.error(`${what}: Stripe refused to read the account (${describeFailure(error)})`);
      return { status: 200, body: { received: true } };
    }
    console.error(`${what} failed; Stripe will deliver it again: ${describeFailure(error)}`);
    return { status: 500, body: { error: "Processing failed" } };
  }
}

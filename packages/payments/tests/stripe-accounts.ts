import { randomBytes } from "node:crypto";
import type Stripe from "stripe";

import {
  recordStripeAccountStatus,
  savePaymentAccount,
  startStripeAccountRead,
  type CardPaymentsStatus,
} from "@shp0/db";

/** A Stripe account id, as Stripe mints them. */
export const newAccountId = () => `acct_${randomBytes(8).toString("hex")}`;

/**
 * Give a Store a saved Stripe account and record a read of it, the way
 * Connect and a read of Stripe would (tests only).
 */
export async function seedStripeAccount(
  storeId: string,
  accountId: string,
  cardPayments: CardPaymentsStatus | null,
): Promise<void> {
  await savePaymentAccount(storeId, accountId);
  const read = await startStripeAccountRead({ storeId });
  if (!read) throw new Error(`no Stripe account saved for Store ${storeId}`);
  await recordStripeAccountStatus(read, { cardPayments, canTakePayments: cardPayments === "active" });
}

/** The signing secret of the thin account-event destination in tests. */
export const THIN_SECRET = "whsec_test_account_events";

/**
 * A thin event notification (Accounts v2) as Stripe sends it: no data, the
 * account as related_object.
 */
export function thinEvent({
  type,
  account,
  livemode = false,
  context = null,
  extra = {},
}: {
  type: string;
  account: string | null;
  livemode?: boolean;
  context?: string | null;
  extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: `evt_test_${randomBytes(8).toString("hex")}`,
    object: "v2.core.event",
    type,
    livemode,
    created: new Date().toISOString(),
    context,
    ...(account === null ? {} : { related_object: { id: account, type: "v2.core.account", url: `/v2/core/accounts/${account}` } }),
    ...extra,
  });
}

/** A Stripe-Signature header for `payload`, as Stripe signs it. */
export function sign(stripe: Stripe, payload: string, secret = THIN_SECRET, timestamp?: number): string {
  return stripe.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp === undefined ? {} : { timestamp }) });
}

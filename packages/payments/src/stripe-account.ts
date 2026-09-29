import type Stripe from "stripe";

import { getPaymentAccount, type CardPaymentsStatus } from "@shp0/db";

/** What Stripe's answer means for taking card payments. */
export type StripeAccountSummary = {
  canTakePayments: boolean;
  cardPayments: CardPaymentsStatus | null;
  closed: boolean;
  needsInfo: boolean;
  contactStripe: boolean;
  due: "currently_due" | "eventually_due" | "past_due" | null;
  dueAt: string | null;
};

export type StripeAccountDeps = { stripe: () => Stripe };

export type ConnectOutcome =
  | { kind: "onboarding"; url: string }
  | { kind: "active" }
  | { kind: "closed" }
  | { kind: "missing" }
  | { kind: "busy" }
  | { kind: "unavailable" };

export type StripeAccountView =
  | { connected: false }
  | {
      connected: true;
      accountId: string;
      fresh: boolean;
      missing: boolean;
      summary: StripeAccountSummary | null;
      canTakePayments: boolean;
      cardPayments: CardPaymentsStatus | null;
      checkedAt: Date | null;
    };

// Ported unchanged from apps/web/lib/stripe.ts#createConnectAccountAndOnboardingLink.
export function accountCreateParams(storeId: string): Record<string, unknown> {
  return { type: "express", business_type: "company", metadata: { storeId } };
}

// Today account creation carries no idempotency key.
export function accountIdempotencyKey(_storeId: string): string {
  return "";
}

// Ported unchanged from apps/web/lib/stripe.ts.
export function onboardingUrls(_origin: string, _storeId: string): { refresh_url: string; return_url: string } {
  return {
    refresh_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
  };
}

// Today nothing reads the account from Stripe.
export function summarizeStripeAccount(_account: Stripe.V2.Core.Account): StripeAccountSummary {
  return {
    canTakePayments: false,
    cardPayments: null,
    closed: false,
    needsInfo: false,
    contactStripe: false,
    due: null,
    dueAt: null,
  };
}

// Ported unchanged from apps/web/app/actions/stripe.ts#onboardConnectAction and apps/web/lib/stripe.ts.
export async function connectStripeAccount(
  deps: StripeAccountDeps,
  request: { storeId: string; origin: string },
): Promise<ConnectOutcome> {
  const stripe = deps.stripe();
  const urls = onboardingUrls(request.origin, request.storeId);
  const existing = await getPaymentAccount(request.storeId);
  if (existing) {
    const link = await stripe.accountLinks.create({ account: existing.connectAccountId, ...urls, type: "account_onboarding" });
    return { kind: "onboarding", url: link.url };
  }
  const account = await stripe.accounts.create({
    type: "express",
    business_type: "company",
    metadata: { storeId: request.storeId },
  });
  const link = await stripe.accountLinks.create({ account: account.id, ...urls, type: "account_onboarding" });
  return { kind: "onboarding", url: link.url };
}

// Today nothing reads the account from Stripe: the stored flags are all there is.
export async function syncStripeAccount(_deps: StripeAccountDeps, storeId: string): Promise<StripeAccountView> {
  const account = await getPaymentAccount(storeId);
  if (!account) return { connected: false };
  return {
    connected: true,
    accountId: account.connectAccountId,
    fresh: false,
    missing: false,
    summary: null,
    canTakePayments: account.chargesEnabled,
    cardPayments: account.cardPaymentsStatus,
    checkedAt: account.statusCheckedAt,
  };
}

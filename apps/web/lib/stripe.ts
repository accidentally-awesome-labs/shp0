import Stripe from "stripe";

/**
 * Stripe server-side singleton (Issue #10).
 * Lazily created so the app builds without STRIPE_SECRET_KEY set.
 */
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-06-24.dahlia",
    });
  }
  return _stripe;
}

/**
 * Create a Stripe Connect Express account for a Store and return the
 * Account Link URL for onboarding.
 */
export async function createConnectAccountAndOnboardingLink(opts: {
  storeId: string;
  storeName: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();

  const account = await stripe.accounts.create({
    type: "express",
    business_type: "company",
    metadata: { storeId: opts.storeId },
  });

  const accountLink = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    type: "account_onboarding",
  });

  return { url: accountLink.url };
}

/**
 * Create a new Account Link for an existing Connect account (if onboarding
 * expired or the merchant needs to update details).
 */
export async function createOnboardingLink(connectAccountId: string): Promise<{ url: string }> {
  const stripe = getStripe();
  const accountLink = await stripe.accountLinks.create({
    account: connectAccountId,
    refresh_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    type: "account_onboarding",
  });
  return { url: accountLink.url };
}

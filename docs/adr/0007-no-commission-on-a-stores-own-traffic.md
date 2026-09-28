# 0007 — No Commission on a Store's Own Traffic

Date: 2026-09-28
Status: Accepted (decision #70)

## Context

Commission was defined as a percentage of each paid Order, set by the Store's Tier and collected as the Stripe Connect application fee on top of Stripe's processing fee. The code did not agree with itself on the rate:
- The billing page shows 3%, 2% and 1% by Tier.
- The payment code would charge a flat 2.5% on every Tier (`stores.commission_bps`, default 250).
- `getTierCommissionBps` is only called from tests.

At Stripe's list rate, any of these makes shp0 dearer than Shopify on Shopify Payments at every sales volume the strategy report modelled. The 2% shown for Pro also equals the fee Shopify's Basic plan charges merchants who use their own payment provider, one of the most resented fees in e-commerce. It would also undercut the case for Merchant-owned Stripe accounts (ADR-0006): no penalty for using your own Stripe account.

## Decision

1. shp0 takes **no Commission (0%)** on Orders from a Store's own traffic, on every Tier. A Store's own traffic means its storefront, its API and AI agents acting for its Customers.
2. No platform fee is added to a Store's payments. Checkout sends no `application_fee_amount` (ADR-0006).
3. shp0's revenue comes from Tier subscriptions. Tier prices are decided separately (#75).
4. A fee on demand that shp0 itself creates, such as a discovery surface, is not decided here. It waits for legal advice.

## Alternatives Considered

- **A Tier-based Commission (3% / 2% / 1%)**, as the billing page shows. It keeps the per-Order revenue stream, but makes shp0 dearer than the incumbent and brings back the resented "own payment provider" fee. Rejected.
- **A flat 2.5% Commission**, as the payment code does today. It has the same drawbacks, and was never a decision. Rejected.

## Consequences

- `CONTEXT.md`'s Commission, Tier and Subscription entries no longer carry a Commission rate.
- The Checkout parameters become simpler: no application fee, no transfer.
- The Commission code is removed by the Checkout work:
  - `stores.commission_bps` and its `schema.ts` field;
  - `Tier.commissionBps`, the Tier Commission rates and `getTierCommissionBps`;
  - `computeApplicationFee` and `getStoreCommissionBps`;
  - the Commission shown on the billing page (the Current plan line and each Tier card);
  - the tests that assert Commission rates or fees.
- #20 (refunds) no longer includes Commission reversal: a refund reverses no platform fee.
- If a Commission is ever introduced, for example on shp0-originated demand, it needs a new ADR. It would be an application fee on a direct charge, which ADR-0006's model supports.

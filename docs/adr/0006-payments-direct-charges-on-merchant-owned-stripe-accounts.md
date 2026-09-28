# 0006 — Payments: Direct Charges on Merchant-Owned Stripe Accounts

Date: 2026-09-28
Status: Accepted for test mode, provisional (decision #74, final on 2026-10-26). Live mode is not enabled by this ADR.

## Context

No Store can take a payment today:
- **Onboarding.** The code creates a Stripe Express account and never saves it.
- **Checkout.** It builds Checkout Session parameters that mix two Stripe Connect patterns. The session is created _on_ the Store's account (a direct charge), but it also sets `payment_intent_data.transfer_data.destination` (a destination-charge field) and a top-level `application_fee_amount` (not a Checkout Session parameter in `stripe@22.3.0`).
- **The webhook.**
  - It marks an Order paid without checking whether the money arrived, or its amount. It finds the Order only within the Store of the event's account, but the session carries no Store id to cross-check.
  - It answers 400 or 500 to data that will never change, so Stripe keeps retrying those events for days. Examples: no order id, an unknown account, an Order that is missing, voided or cancelled, a deleted Variant.

The owner decided on 2026-09-28:
- to start payments now, in test mode, on decision #74's provisional recommendation: direct charges on a Merchant-owned Stripe account;
- that a payment taken for stock that has run out is refunded automatically, keeping ADR-0002;
- that shp0 takes no Commission (decision #70, recorded in ADR-0007).

This ADR records the charge model and the rules every payment path follows.

## Decision

1. **Direct charges on the Store's own Stripe account.**
   - Every Checkout Session, PaymentIntent, Charge and Refund for an Order is created on the Store's Stripe account, via the `Stripe-Account` header.
   - shp0 creates no destination charges and sends no `transfer_data`, `on_behalf_of` or `application_fee_amount` (ADR-0007: no Commission).
   - shp0 never holds a Customer's money and is not the merchant of record; the Store is.

2. **One Merchant-owned Stripe account per Store.**
   - A Store has at most one Stripe account, and a Stripe account serves at most one Store: the webhook finds the Store from the account.
   - New accounts are created with Accounts v2:
     - `dashboard: 'full'`, so the Merchant has the full Stripe Dashboard;
     - `defaults.responsibilities` set explicitly to `{ fees_collector: 'stripe', losses_collector: 'stripe' }`, because v2 has no default;
     - the merchant configuration, requesting the card payments capability.
   - Account creation carries the idempotency key `account:<Store id>`, and its id is saved as soon as Stripe returns it, before onboarding. A second or concurrent attempt therefore reuses the account instead of creating another. A saved account id is never replaced by a later attempt.
   - A Store can take payments only while Stripe reports its account able to accept card payments. shp0 reads that from Stripe, when the Merchant returns from onboarding and on account events, never from anything the Merchant submits.
   - Connecting a Merchant's _existing_ Stripe account waits for #74's questions to Stripe.
   - Connecting an account stays an Admin capability (`settings.manage`), as today.

3. **Checkout.** A Checkout Session is created only for a `pending` Order of the Current Store, only when the request carries the cart token that placed the Order (as today), and only when the Store's account can take payments.
   - **Line items and total.** The line items are the Order Lines at their stored unit prices, in the Store's Currency (USD until the Store's Currency is stored, ADR-0004). The session's total must equal the Order's total, or no session is created.
   - **Orders Stripe cannot charge get no session**, and the storefront says the Order cannot be paid online:
     - a total of 0;
     - a total below Stripe's minimum for the Currency (50 cents for USD);
     - a total above Stripe's maximum (99,999,999 minor units);
     - more than 100 lines.

     Whether a zero-total Order can become paid without Stripe is not decided here.
   - **Metadata.** The session's `metadata` and its PaymentIntent's `metadata` (`payment_intent_data.metadata`) both carry `shp0_store_id` and `shp0_order_id`. The namespaced keys matter: the Merchant's own Stripe account may also serve other integrations.
   - **Return URLs.** The success and cancel URLs are on the storefront host that served the request, and point back at the Order.
   - **One live session per Order**, recorded on the Order:
     - Pay reuses the recorded session while it is `open`.
     - A new session is created only when the recorded one is `expired`, or is `complete` and its asynchronous payment failed.
     - A `complete` session that is `paid` or still `unpaid` blocks a new session, and the Customer is told the payment is being processed.
     - When shp0 must replace an open session, it expires it first. If the expire call fails, or finds the session `complete`, no new session is created.
     - Session requests carry an idempotency key per Order and attempt.
   - **Type checking.** The parameters are an object literal checked with `satisfies Stripe.Checkout.SessionCreateParams`. An `as` cast, or a value of another named type, skips TypeScript's excess-property check.

4. **Webhooks.**
   - **Endpoint:** one Connect webhook endpoint (`connect: true`) at `/api/stripe/webhook`, created with API version `2026-06-24.dahlia` (the SDK's pinned version).
   - **Events:** `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`. Account status changes on Accounts v2 arrive as thin events with their own destination and secret.
   - **Signature:** it is verified first. Only a request that fails verification is answered 400.
   - **Anything that is not shp0's** is answered 200 and changes nothing:
     - a `livemode` other than the configured key's mode;
     - an event type not listed above;
     - an account that belongs to no Store;
     - a session without both shp0 metadata keys;
     - a session whose `shp0_store_id` is not the account's Store.

     shp0 logs only the event id, type, account and the reason it was ignored, never the event's object: on a Merchant-owned account those events include other businesses' Customers.
   - **5xx** is answered only for failures a retry can fix, such as the database or Stripe being unavailable. It is never answered for data that will be the same on the next delivery.
   - **When a session pays:** only when its `payment_status` is `paid`, on `checkout.session.completed` or on `checkout.session.async_payment_succeeded`.
     - `unpaid` waits for the async events.
     - `no_payment_required` never pays an Order; it is logged and answered 200.
     - `async_payment_failed` leaves the Order `pending`.

5. **The Payment record.**
   - Each PaymentIntent the webhook accepts for an Order is recorded once, as a Payment: the Store, Order, Stripe account, amount, currency and outcome. It is keyed by the PaymentIntent id, which is unique.
   - The webhook looks the Payment up by PaymentIntent id before any other check. A PaymentIntent that already has a Payment is never applied or refunded a second time: a redelivery only retries a refund that is still owed (point 6).
   - Recording the Payment, the Order's `pending → paid` and the inventory decrement commit in the single payment transaction of ADR-0002.
   - That transaction locks the Order row, then the Variants in id order (PR #87).

6. **Automatic full refunds.** A payment that shp0 will not honour is refunded in full, straight away, on the Store's account. That covers four cases:
   - the stock ran out, or a Variant was deleted, between checkout and payment (ADR-0002 point 4: the Order stays `pending`);
   - the Order was already paid by a different PaymentIntent, for example a second checkout;
   - the amount or currency differs from the Order's;
   - the Order is not in that Store, or is no longer `pending` and was not paid by this PaymentIntent.

   **How a refund is carried out:**
   1. **Recorded first.** The Payment is recorded with the outcome _refund due_ and its reason, in the same transaction that decides it, before the refund is requested.
   2. **Requested.** The request carries no amount, so Stripe refunds whatever is still refundable, and it carries the idempotency key `refund:<PaymentIntent id>`.
   3. **Result.** A created refund, or Stripe's answer that the charge is already refunded, makes the Payment _refunded_.
   4. **Retryable failures** (network, rate limit, Stripe unavailable, a key already in use) are answered 5xx, so that Stripe delivers the event again. Stripe returns a key's saved result, even an error, for at least 24 hours; after that a retry is executed again.
   5. **Any other refusal**, such as a disputed charge or lost access to the account, is answered 200. It makes the Payment _refund failed_, with Stripe's error code, for a Store Admin or an Operator to refund by hand.

   Stripe stops delivering an event after some days. Before live mode, _refund due_ Payments must also be retried outside the webhook.

7. **Idempotency is layered.**
   - `processed_events` skips an event that was already handled.
   - The unique Payment and the locked Order row make a repeated, or concurrent, delivery of the same payment change nothing, except retrying a refund that is still due.
   - Stripe idempotency keys make a repeated account, session or refund request return the first result.

8. **Testing without Stripe.**
   - CI cannot reach Stripe. Tests point the Stripe SDK at a local fake Stripe server, configured with its `host`, `port` and `protocol` options. The fake records every request: method, path, parameters, `Stripe-Account` and `Idempotency-Key`.
   - Events are signed with the SDK's `webhooks.generateTestHeaderString`.
   - Database effects run against Postgres, like the other integration suites.
   - Agents use test-mode keys only. Live keys and live mode are set by a human.

## Alternatives Considered

- **Destination charges on Express accounts** (half of today's code). shp0 would take part in every payment's funds flow. With Express accounts, shp0 would carry Merchants' losses and negative balances (`losses.payments: 'application'`), per a search summary of Stripe's controller-properties guide; that liability is the reason this was rejected. It also contradicts the Merchant-owned-account model that #74 recommends. Rejected.
- **Authorize first, capture after the stock check** (manual capture). An oversold payment would be released rather than refunded, which as we understand Stripe's pricing also avoids the processing fee a refund leaves with the Store. But it needs a new Checkout step, an `authorized` payment status and an amendment to ADR-0002, and not every payment method supports manual capture. Not chosen (owner, 2026-09-28).
- **Mark the Order paid and let the Merchant refund by hand.** The Customer is charged for goods that do not exist until someone notices. Rejected.

## Consequences

- **Fees and losses.** The Store bears Stripe's fees, refunds and disputes. Stripe collects the fees and carries negative balances (`fees_collector` and `losses_collector: 'stripe'`); both depend on Stripe's answer to #74 Q3.
- **Cost of automatic refunds.** As we understand Stripe's pricing, it keeps its processing fee on a refunded payment. So each automatic refund (stock that ran out, or a second payment) costs the Store that fee, with no sale.
- **A Customer who pays for stock that has just run out** is refunded in full automatically. The Order stays `pending`, so it can be paid again if the Merchant restocks. The Order page shows that the Order was not paid and that the payment was refunded.
- **Webhook setup.** The endpoint must be a Connect endpoint (`connect: true`). Setup notes must record its URL, events, API version and signing secrets.
- **Testing.** The rules above are testable offline. Every payment path is tested against the fake Stripe server and signed events.
- **Out of scope here, each its own work item:**
  - refunds and disputes made in the Stripe Dashboard (`charge.refunded`, `charge.dispute.*`);
  - Merchant-initiated and partial refunds (#20);
  - connecting an existing Stripe account (#74 Q1);
  - tax (#32);
  - storing the Store's Currency;
  - the Customer's email and delivery address on the Order;
  - retrying _refund due_ Payments outside the webhook, needed before live mode.

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
     - the merchant configuration, requesting the card payments capability (`configuration.merchant.capabilities.card_payments.requested: true`);
     - `metadata.shp0_store_id`, and nothing else: nothing the Merchant typed (no email, name or country). Stripe refuses a reused idempotency key with other parameters, so the parameters are a constant of the Store id; Stripe's hosted onboarding collects the rest.
   - Account creation carries the idempotency key `account:<Store id>` (the Store id in lower case), and its id is saved as soon as Stripe returns it, before onboarding. A second or concurrent attempt therefore reuses the account instead of creating another. A saved account id is never replaced by a later attempt; an account created meanwhile is logged and left unused. A save that fails is logged with the account Stripe created.
   - The key is the same on every attempt, so if Stripe keeps a failed create's answer under it (as v1 keeps errors; #74 asks about v2), later attempts get that answer back until Stripe drops the key. Such a failure is logged with the key. An answer Stripe marks as replayed (`Idempotent-Replayed: true`, as v1 does) tells the Admin to contact support; any other is "try again, and contact support if it keeps failing".
   - The database enforces it: a saved account id and its Store cannot be updated, a saved account cannot be deleted except with its Store, and an account id belongs to one Store.
   - A Store can take payments only while Stripe reports its account able to accept card payments: the account is not closed, its merchant configuration is applied, and `configuration.merchant.capabilities.card_payments.status` is `active` (read with `include: ['configuration.merchant', 'requirements']`). Any other status, a missing value, or an account Stripe no longer has (404) or no longer lets shp0 read (403) means it cannot.
   - shp0 reads that from Stripe, never from anything the Merchant submits or from a URL: whenever an Admin opens the Store's Payments page (where Stripe's onboarding returns), before offering onboarding for a saved account, and on account events. A read that began before the one recorded never overwrites it.
   - shp0 offers Stripe's onboarding for a saved account only while Stripe says it cannot take card payments or asks the Merchant for information. What the Merchant owes is read from the requirements awaiting them (`awaiting_action_from: 'user'`), not from the summary deadline, which also covers what Stripe itself is reviewing. An onboarding link is a bearer credential: it is never stored or logged.
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
   - **Orders shp0 would only refund get no session either**, and the storefront says why:
     - a Variant of the Order has been deleted;
     - there is less stock than the Order's quantity of a Variant, counting every line of it.

     Pay checks stock without reserving it. Stock that runs out after Pay is still refunded (point 6).
   - **Metadata.** The session's `metadata` and its PaymentIntent's `metadata` (`payment_intent_data.metadata`) both carry `shp0_store_id` and `shp0_order_id`. The namespaced keys matter: the Merchant's own Stripe account may also serve other integrations.
   - **Return URLs.** The success and cancel URLs are on the storefront host that served the request, and point back at the Order.
   - **One live session per Order**, recorded on the Order:
     - Pay reuses the recorded session while it is `open`. An open session is never replaced.
     - A new session is created only when the recorded one can no longer take money for the Order: it is `expired`, or it no longer exists on the Store's account; or it is `complete` and its delayed payment failed or was canceled, it took no payment, or its payment was refunded automatically (point 6). A refund Stripe has created but not yet finished counts as refunded, as in point 6.
     - Any other `complete` session blocks a new one, and the Customer is told why. Such a payment is reported first, before the stock or account checks above, which may have changed since:
       - its payment is `paid` and not yet recorded, or still processing: the payment is being processed;
       - its automatic refund is still due, or Stripe refused it (_refund failed_): that money is still held, so the Customer is not asked to pay again. A _refund failed_ Payment blocks Pay on that Order until a person resolves it; nothing records a refund made by hand yet (see Consequences).
     - Each new session belongs to a new attempt, reserved on the Order before Stripe is called. Its request carries the idempotency key `checkout:<Order id>:<attempt>`.
     - A Pay that finds an attempt with no session yet, started less than a minute ago, sends that attempt's key again, so Stripe returns the same session (or answers 409 while it is still creating it: the Customer is asked to try again in a moment). After that minute, the attempt is over and the next Pay starts a new one.
     - Pay's Stripe requests are not retried by the SDK, except for its one resend after a dropped connection. With a 20-second timeout, they normally end well within that minute. Correctness does not depend on it: a session that comes back after its attempt was superseded is never recorded, so never given out.
     - A create that fails ends its attempt, since Stripe keeps a key's error: the Customer's next Pay starts a new attempt, with its own key.
     - A session is given to the Customer only once it is recorded on the Order, while the Order is still `pending`. So an Order never has two sessions a Customer could pay.
   - **The Order page** offers Pay only when Pay would send the Customer to Stripe. It reads the recorded session from Stripe, as Pay does (with a shorter timeout), and never takes the payment's state from its URL. If Stripe cannot be read, it offers Pay, which checks again, except just after the Customer came back from Stripe.
   - **Type checking.** The parameters are an object literal checked with `satisfies Stripe.Checkout.SessionCreateParams`. An `as` cast, or a value of another named type, skips TypeScript's excess-property check.

4. **Webhooks.**
   - **Endpoint:** one Connect webhook endpoint (`connect: true`) at `/api/stripe/webhook`, created with API version `2026-06-24.dahlia` (the SDK's pinned version).
   - **Events:** `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`. Account status changes on Accounts v2 arrive as thin events with their own destination and secret.
   - **Account events** arrive at `/api/stripe/account-events`, a thin event destination with its own signing secret, `STRIPE_ACCOUNT_EVENTS_SECRET`:
     - `v2.core.account[configuration.merchant].capability_status_updated`, `v2.core.account[configuration.merchant].updated`, `v2.core.account[requirements].updated`, `v2.core.account.updated` and `v2.core.account.closed`;
     - the notification is only a trigger: shp0 reads the account again from Stripe, as the platform, and uses nothing else from the event, so a redelivery reads again instead of being skipped (no `processed_events` record);
     - the same 400, 200 and 5xx rules as below apply.
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
   2. **Requested.** The request carries no amount, so Stripe refunds whatever is still refundable. Each attempt carries its own idempotency key, `refund:<PaymentIntent id>:<attempt>`. Stripe keeps a key's first result, even an error, for at least 24 hours, so a retry under the same key would only get the same failure back. A new key per attempt is safe because a full refund cannot be made twice: once the charge is refunded, Stripe answers that it is already refunded.
   3. **Result.** A created refund (its id and status recorded), or Stripe's answer that the charge is already refunded, makes the Payment _refunded_.
   4. **Retryable failures** (no answer, rate limit, Stripe unavailable, a key already in use) are answered 5xx, so that Stripe delivers the event again, and the next attempt is made.
   5. **Any other refusal**, such as a disputed charge or lost access to the account, is answered 200. It makes the Payment _refund failed_, with Stripe's error code, for a Store Admin or an Operator to refund by hand.

   Stripe stops redelivering an event: as we understand its webhook documentation, after up to three days in live mode, and after a few hours (three retries) in test mode. Before live mode, _refund due_ Payments must also be retried outside the webhook.

7. **Idempotency is layered.**
   - `processed_events` skips an event that was already handled.
   - The unique Payment and the locked Order row make a repeated, or concurrent, delivery of the same payment change nothing, except retrying a refund that is still due.
   - Stripe idempotency keys make a repeated account or session request return the first result, for as long as Stripe keeps the key. After a save that failed, a retry within that time gets the account back and saves it; a retry after it creates and saves another, and the first, logged at the failed save, is left unused. Refund attempts have a key each, and a charge cannot be refunded twice.

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
- **Webhook setup.** The endpoint must be a Connect endpoint (`connect: true`). The account events need a second, thin destination (`event_payload: 'thin'`) at `/api/stripe/account-events`, with the events above and its own secret. Setup notes must record both destinations' URLs, events, API version and signing secrets.
- **Accounts in test mode do not carry over to live mode.** Going live needs a decision on the Stores' saved test-mode accounts, since a saved account is never replaced.
- **The database changes** to `stripe_payment_accounts` (the status columns, its rules and the read sequence) are applied by a person on an existing database: `applySchema` runs only in tests.
- **Testing.** The rules above are testable offline. Every payment path is tested against the fake Stripe server and signed events.
- **Out of scope here, each its own work item:**
  - refunds and disputes made in the Stripe Dashboard (`charge.refunded`, `charge.dispute.*`);
  - Merchant-initiated and partial refunds (#20);
  - connecting an existing Stripe account (#74 Q1);
  - tax (#32);
  - storing the Store's Currency;
  - the Customer's email and delivery address on the Order;
  - retrying _refund due_ Payments outside the webhook, needed before live mode;
  - replacing a Store's closed Stripe account, or one Stripe no longer has or no longer lets shp0 use: today such a Store cannot take payments, and needs an Operator decision;
  - letting a Store whose account creation Stripe keeps refusing under its key try again under another key (needs #74's answer on v2 replays);
  - showing Operators each Store's Stripe account and status;
  - resolving a _refund failed_ Payment once a person has refunded it (handling `charge.refunded`, or an Admin or Operator action); until then, Pay stays blocked on that Order;
  - following a refund that Stripe created but that later fails (`refund.updated`, `refund.failed`).

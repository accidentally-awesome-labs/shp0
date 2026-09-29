import Stripe from "stripe";

import {
  CHECKOUT_ATTEMPT_LEASE_SECONDS,
  endCheckoutAttempt,
  getOrderForCheckout,
  getPaymentAccount,
  getPaymentStatus,
  recordCheckoutSession,
  reserveCheckoutAttempt,
  STORE_CURRENCY,
  type OrderForCheckout,
} from "@shp0/db";

/** Why Pay does not send the Customer to Stripe. */
export type CheckoutBlock =
  /** No such Order in this Store for this cart token (or no cart token). */
  | "not_found"
  /** The Order is paid, voided or cancelled. */
  | "not_pending"
  /** A Variant of the Order has been deleted. */
  | "item_unavailable"
  /** Not enough stock for the Order now. */
  | "out_of_stock"
  /** Stripe cannot charge it: its amount, its number of lines, or lines that do not add up. */
  | "not_chargeable"
  /** The Store's Stripe account cannot take payments (or it has none). */
  | "payments_not_set_up"
  /** The Order's session has taken a payment that is still being processed. */
  | "processing"
  /**
   * The Order's session took a payment that shp0 did not honour, and its
   * refund is still owed or failed: that money is still held, so the
   * Customer is not asked to pay again.
   */
  | "refund_pending"
  /** Another Pay for the Order is creating its session right now. */
  | "in_progress";

export type CheckoutOutcome = { kind: "redirect"; url: string } | { kind: "blocked"; reason: CheckoutBlock };

export type CheckoutAvailability = { available: true } | { available: false; reason: CheckoutBlock };

export type CheckoutDeps = {
  /** Stripe API client (the platform's key; requests go to the Store's account). */
  stripe: Stripe;
};

export type CheckoutRequest = {
  storeId: string;
  orderId: string;
  /** The Customer's cart token (cookie), which must be the one that placed the Order. */
  cartToken: string | null | undefined;
  /** The origin of the storefront host that served the request, e.g. https://shop.example.com. */
  origin: string;
};

/** Stripe's limits for a Checkout Session in USD (ADR-0006). */
const MIN_AMOUNT = 50;
const MAX_AMOUNT = 99_999_999;
const MAX_LINES = 100;

/**
 * Options for each of Pay's Stripe requests. No retries: the SDK would
 * resend on a timeout, a 409 or a 5xx, and a Pay that fails is simply tried
 * again by the Customer. The SDK still resends once after a closed
 * connection, so one request can take up to about twice the timeout, which
 * stays within the attempt lease: a request still running is never taken
 * for an attempt that is over.
 */
const STRIPE_REQUEST = { timeout: 20_000, maxNetworkRetries: 0 } as const;
if (2 * STRIPE_REQUEST.timeout + 1_000 >= CHECKOUT_ATTEMPT_LEASE_SECONDS * 1000) {
  throw new Error("Pay's Stripe requests must end within the Checkout attempt lease");
}

/** How many times Pay looks again after the Order changed under it. */
const ROUNDS = 3;

/**
 * Whether Pay would send the Customer to Stripe now: the Order page shows
 * the Pay button only when it would. The same checks as startCheckout, and
 * the same reading of the Order's recorded session (asked of Stripe only
 * when there is one), without creating anything.
 */
export async function getCheckoutAvailability(
  deps: CheckoutDeps,
  request: Omit<CheckoutRequest, "origin">,
): Promise<CheckoutAvailability> {
  const loaded = await load(request);
  if ("reason" in loaded) return { available: false, reason: loaded.reason };
  const { sessionId } = loaded.order.checkout;
  if (sessionId === null) return { available: true };
  const recorded = await recordedSession(deps.stripe, request.storeId, loaded.stripeAccount, sessionId);
  if (recorded.state === "processing" || recorded.state === "refund_pending") {
    return { available: false, reason: recorded.state };
  }
  return { available: true };
}

/**
 * Pay (ADR-0006): send the Customer to Stripe Checkout for a pending Order of
 * the Store, placed with their cart token, on the Store's own Stripe account.
 *
 * - Only an Order Stripe can charge now gets a session: all its Variants
 *   still exist and are in stock, its lines add up to its total, the total is
 *   within Stripe's limits, it has at most 100 lines, and the Store's account
 *   can take payments. Otherwise the reason is returned and Stripe is not
 *   called.
 * - One live session per Order. The recorded session is reused while it is
 *   open. A new one is created only when the recorded one is expired, is
 *   gone from the account, or is complete without money held for the Order
 *   (its delayed payment failed, or its payment was refunded automatically).
 *   A complete session whose payment is paid or still processing blocks Pay
 *   with `processing`; one whose automatic refund is still owed or failed,
 *   with `refund_pending`.
 * - A new session belongs to a new attempt, started with
 *   reserveCheckoutAttempt, and carries the idempotency key
 *   `checkout:<Order id>:<attempt>`. A Pay that finds an attempt still
 *   being created uses the same key, so Stripe returns that attempt's
 *   session (or its error) instead of creating another.
 * - A session is given to the Customer only once it is recorded on the
 *   Order (recordCheckoutSession). One that cannot be recorded (the Order
 *   changed meanwhile) is never delivered, and Pay looks again.
 *
 * Throws on a Stripe or database failure; nothing is delivered then. A
 * failed create ends its attempt (endCheckoutAttempt), because Stripe keeps
 * the error for that attempt's key: the Customer's next Pay starts a new
 * attempt with its own key.
 */
export async function startCheckout(deps: CheckoutDeps, request: CheckoutRequest): Promise<CheckoutOutcome> {
  assertOrigin(request.origin);

  for (let round = 0; round < ROUNDS; round++) {
    const loaded = await load(request);
    if ("reason" in loaded) return blocked(loaded.reason);
    const { order, stripeAccount } = loaded;
    const { attempt, sessionId, inFlight } = order.checkout;

    if (sessionId !== null) {
      const recorded = await recordedSession(deps.stripe, request.storeId, stripeAccount, sessionId);
      if (recorded.state === "open") return { kind: "redirect", url: recorded.url };
      if (recorded.state === "processing" || recorded.state === "refund_pending") return blocked(recorded.state);
      // Replaceable: fall through to a new attempt.
    } else if (inFlight) {
      // Another Pay started this attempt moments ago: its key returns its session.
      const outcome = await createAndRecord(deps.stripe, request, order, stripeAccount, attempt);
      if (outcome) return outcome;
      continue;
    }

    const next = await reserveCheckoutAttempt(request.storeId, order.id, { attempt, sessionId });
    if (next === null) continue; // Another Pay moved the Order on: look again.
    const outcome = await createAndRecord(deps.stripe, request, order, stripeAccount, next);
    if (outcome) return outcome;
  }
  return blocked("in_progress");
}

type Loaded = { order: OrderForCheckout; stripeAccount: string } | { reason: CheckoutBlock };

async function load(request: Omit<CheckoutRequest, "origin">): Promise<Loaded> {
  const order = await getOrderForCheckout(request.storeId, request.orderId, request.cartToken);
  if (!order) return { reason: "not_found" };
  if (order.paymentStatus !== "pending") return { reason: "not_pending" };

  const account = await getPaymentAccount(request.storeId);
  if (!account || !account.chargesEnabled) return { reason: "payments_not_set_up" };

  const reason = orderBlock(order);
  return reason ? { reason } : { order, stripeAccount: account.connectAccountId };
}

/** Why Stripe cannot charge this pending Order now, if it cannot. */
function orderBlock(order: OrderForCheckout): CheckoutBlock | null {
  if (order.lines.some((line) => line.productTitle === null)) return "item_unavailable";

  const wellFormed = order.lines.every(
    (line) =>
      Number.isSafeInteger(line.quantity) &&
      line.quantity >= 1 &&
      Number.isSafeInteger(line.unitPriceCents) &&
      line.unitPriceCents >= 0,
  );
  const sum = order.lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0);
  if (
    !wellFormed ||
    order.lines.length === 0 ||
    order.lines.length > MAX_LINES ||
    sum !== order.totalCents ||
    order.totalCents < MIN_AMOUNT ||
    order.totalCents > MAX_AMOUNT
  ) {
    return "not_chargeable";
  }

  // Every line of a Variant counts against its stock.
  const wanted = new Map<string, number>();
  for (const line of order.lines) wanted.set(line.variantId, (wanted.get(line.variantId) ?? 0) + line.quantity);
  if (order.lines.some((line) => (line.inventory ?? 0) < wanted.get(line.variantId)!)) return "out_of_stock";

  return null;
}

type RecordedSession =
  | { state: "open"; url: string }
  | { state: "processing" }
  | { state: "refund_pending" }
  | { state: "replaceable" };

/** What the Order's recorded session allows: reuse it, wait, or replace it. */
async function recordedSession(
  stripe: Stripe,
  storeId: string,
  stripeAccount: string,
  sessionId: string,
): Promise<RecordedSession> {
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(
      sessionId,
      { expand: ["payment_intent"] },
      { stripeAccount, ...STRIPE_REQUEST },
    );
  } catch (error) {
    // Not on the Store's account: nobody can pay it.
    if (error instanceof Stripe.errors.StripeError && error.statusCode === 404) return { state: "replaceable" };
    throw error;
  }

  if (session.status === "open") {
    if (!session.url) throw new Error(`Stripe returned open Checkout Session ${session.id} without a URL`);
    return { state: "open", url: session.url };
  }
  if (session.status === "expired") return { state: "replaceable" };

  // Complete.
  const paymentIntent = session.payment_intent;
  if (session.payment_status === "paid") {
    const paymentIntentId = typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id;
    if (!paymentIntentId) return { state: "processing" };
    // No Payment yet: the webhook has not processed it. A payment the webhook
    // did not honour can be paid again once it is refunded; until then the
    // money is still held (refund owed, or failed and left to a person).
    const payment = await getPaymentStatus(storeId, paymentIntentId);
    if (payment === "refunded") return { state: "replaceable" };
    if (payment === "refund_due" || payment === "refund_failed") return { state: "refund_pending" };
    return { state: "processing" };
  }
  if (session.payment_status === "no_payment_required") return { state: "replaceable" };

  // Unpaid: a delayed payment method, still processing or failed.
  const status = typeof paymentIntent === "object" && paymentIntent !== null ? paymentIntent.status : null;
  return status === "requires_payment_method" || status === "canceled"
    ? { state: "replaceable" }
    : { state: "processing" };
}

/**
 * Create (or, with an attempt's key, get back) the attempt's session and
 * record it. Returns the outcome, or null when the session could not be
 * recorded because the Order changed; it is then not delivered.
 */
async function createAndRecord(
  stripe: Stripe,
  request: CheckoutRequest,
  order: OrderForCheckout,
  stripeAccount: string,
  attempt: number,
): Promise<CheckoutOutcome | null> {
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(sessionParams(request, order), {
      stripeAccount,
      idempotencyKey: `checkout:${order.id}:${attempt}`,
      ...STRIPE_REQUEST,
    });
  } catch (error) {
    // Stripe is still running the other request with this key.
    if (error instanceof Stripe.errors.StripeError && error.statusCode === 409) return blocked("in_progress");
    // Nothing was delivered. End the attempt: Stripe keeps this key's error,
    // so the next Pay must use a new one.
    try {
      await endCheckoutAttempt(request.storeId, order.id, attempt);
    } catch (endError) {
      console.error(
        `Could not end Checkout attempt ${attempt} of Order ${order.id}:`,
        endError instanceof Error ? endError.message : String(endError),
      );
    }
    throw error;
  }
  if (!session.url) throw new Error(`Stripe returned Checkout Session ${session.id} without a URL`);
  if (!(await recordCheckoutSession(request.storeId, order.id, attempt, session.id))) return null;
  return { kind: "redirect", url: session.url };
}

/**
 * The Checkout Session for an Order (ADR-0006): a direct charge, with no fee
 * or transfer (ADR-0007), the Order Lines at their stored prices, return URLs
 * on the storefront host, and shp0's metadata on the session and its
 * PaymentIntent. An object literal checked with `satisfies`, so an unknown
 * parameter fails to compile.
 */
function sessionParams(request: CheckoutRequest, order: OrderForCheckout) {
  const metadata = { shp0_store_id: request.storeId, shp0_order_id: order.id };
  return {
    mode: "payment",
    line_items: order.lines.map(
      (line): Stripe.Checkout.SessionCreateParams.LineItem => ({
        quantity: line.quantity,
        price_data: {
          currency: STORE_CURRENCY,
          unit_amount: line.unitPriceCents,
          product_data: { name: lineName(line) },
        },
      }),
    ),
    success_url: `${request.origin}/order/${order.id}?checkout=returned`,
    cancel_url: `${request.origin}/order/${order.id}`,
    client_reference_id: order.id,
    metadata,
    payment_intent_data: { metadata },
  } satisfies Stripe.Checkout.SessionCreateParams;
}

/**
 * A line's name on Stripe's page: the Product, and the Variant unless it is
 * the default one. Stripe refuses an empty name, so a blank Product title
 * falls back to the Variant's, then to "Item".
 */
function lineName(line: OrderForCheckout["lines"][number]): string {
  const product = (line.productTitle ?? "").trim();
  const variant = (line.variantTitle ?? "").trim();
  const namedVariant = variant !== "" && variant !== "Default";
  if (product === "") return namedVariant ? variant : "Item";
  return namedVariant ? `${product} — ${variant}` : product;
}

function assertOrigin(origin: string): void {
  let parsed: URL | null = null;
  try {
    parsed = new URL(origin);
  } catch {
    // Reported below.
  }
  if (!parsed || parsed.origin !== origin || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new Error("startCheckout needs the storefront's origin, such as https://shop.example.com");
  }
}

function blocked(reason: CheckoutBlock): CheckoutOutcome {
  return { kind: "blocked", reason };
}

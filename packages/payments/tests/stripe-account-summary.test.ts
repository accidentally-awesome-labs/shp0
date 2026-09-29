import { describe, it, expect } from "vitest";
import Stripe from "stripe";

import {
  accountCreateParams,
  accountIdempotencyKey,
  describeFailure,
  describeStripeAccount,
  onboardingUrls,
  summarizeStripeAccount,
  type StripeAccountPage,
  type StripeAccountSummary,
  type StripeAccountView,
} from "../src/index";

/**
 * The pure parts of connecting a Store's Stripe account (ADR-0006 point 2):
 * what Stripe's answer means for taking card payments, the exact account
 * creation request, the onboarding return URLs, and what the Payments page
 * says.
 */

const STORE = "0b6b4a1e-2f4c-4d8e-9a55-3c1d2e3f4a5b";

type AccountFields = {
  closed?: boolean;
  applied?: boolean;
  status?: string;
  details?: Array<{ code: string; resolution: string }>;
  entries?: Array<{ awaiting_action_from: "user" | "stripe"; minimum_deadline: { status: string } }>;
  due?: { status: string; time?: string };
  configuration?: "absent" | "null";
};

/** An Accounts v2 account as Stripe returns it with include configuration.merchant and requirements. */
function account(fields: AccountFields = {}): Stripe.V2.Core.Account {
  const body: Record<string, unknown> = {
    id: "acct_test123",
    object: "v2.core.account",
    applied_configurations: ["merchant"],
    closed: fields.closed ?? false,
    created: "2026-09-29T00:00:00Z",
    livemode: false,
    requirements: {
      entries: (fields.entries ?? []).map((entry) => ({ description: "", errors: [], impact: {}, requested_reasons: [], ...entry })),
      summary: fields.due ? { minimum_deadline: fields.due } : {},
    },
  };
  if (fields.configuration === "null") body.configuration = null;
  else if (fields.configuration !== "absent") {
    body.configuration = {
      merchant: {
        applied: fields.applied ?? true,
        capabilities: {
          card_payments: { status: fields.status ?? "active", status_details: fields.details ?? [] },
        },
      },
    };
  }
  return body as unknown as Stripe.V2.Core.Account;
}

const able: StripeAccountSummary = {
  canTakePayments: true,
  cardPayments: "active",
  closed: false,
  needsInfo: false,
  contactStripe: false,
  due: null,
  dueAt: null,
};

describe("summarizeStripeAccount: can the Store take card payments?", () => {
  it("yes only when the account is open, its merchant configuration applied, and card payments active", () => {
    expect(summarizeStripeAccount(account())).toEqual(able);
  });

  it.each<[string, AccountFields, Partial<StripeAccountSummary>]>([
    ["pending", { status: "pending" }, { cardPayments: "pending" }],
    ["restricted", { status: "restricted" }, { cardPayments: "restricted" }],
    ["unsupported", { status: "unsupported" }, { cardPayments: "unsupported" }],
    ["a status Stripe adds later", { status: "future_value" }, { cardPayments: null }],
    ["merchant configuration not applied", { applied: false }, { cardPayments: "active" }],
    ["closed", { closed: true }, { closed: true, cardPayments: "active" }],
    ["no configuration returned", { configuration: "absent" }, { cardPayments: null }],
    ["configuration null", { configuration: "null" }, { cardPayments: null }],
  ])("no: %s", (_name, fields, expected) => {
    expect(summarizeStripeAccount(account(fields))).toMatchObject({ canTakePayments: false, ...expected });
  });

  it("needs information from the Merchant: Stripe asks them to provide it, or it is due from them now", () => {
    expect(
      summarizeStripeAccount(account({ status: "restricted", details: [{ code: "requirements_past_due", resolution: "provide_info" }] })),
    ).toMatchObject({ needsInfo: true, contactStripe: false });
    for (const status of ["currently_due", "past_due"]) {
      expect(
        summarizeStripeAccount(account({ entries: [{ awaiting_action_from: "user", minimum_deadline: { status } }] })),
        status,
      ).toMatchObject({ needsInfo: true, canTakePayments: true });
    }
    // Not for information due only eventually, or awaited from Stripe.
    expect(
      summarizeStripeAccount(
        account({
          entries: [
            { awaiting_action_from: "user", minimum_deadline: { status: "eventually_due" } },
            { awaiting_action_from: "stripe", minimum_deadline: { status: "currently_due" } },
          ],
        }),
      ),
    ).toMatchObject({ needsInfo: false });
  });

  it("must contact Stripe when Stripe offers no way for the Merchant to fix it", () => {
    for (const resolution of ["contact_stripe", "no_resolution"]) {
      expect(
        summarizeStripeAccount(account({ status: "restricted", details: [{ code: "restricted_other", resolution }] })),
        resolution,
      ).toMatchObject({ contactStripe: true, needsInfo: false, canTakePayments: false });
    }
  });

  it("reports Stripe's deadline for what is due", () => {
    expect(summarizeStripeAccount(account({ due: { status: "past_due", time: "2026-10-01T00:00:00Z" } }))).toMatchObject({
      due: "past_due",
      dueAt: "2026-10-01T00:00:00Z",
    });
  });
});

describe("the account creation request", () => {
  it("is exactly ADR-0006's parameters, the same on every attempt, with nothing the Merchant typed", () => {
    const params = accountCreateParams(STORE);
    expect(params).toEqual({
      dashboard: "full",
      defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      metadata: { shp0_store_id: STORE },
    });
    expect(accountCreateParams(STORE)).toEqual(params);
    expect(accountIdempotencyKey(STORE)).toBe(`account:${STORE}`);
  });
});

describe("onboardingUrls: Stripe returns the Merchant to the Store's Payments page", () => {
  it("on the origin the Merchant is signed in on", () => {
    expect(onboardingUrls("https://app.shp0.dev", STORE)).toEqual({
      refresh_url: `https://app.shp0.dev/dashboard/${STORE}/payments?stripe=refresh`,
      return_url: `https://app.shp0.dev/dashboard/${STORE}/payments?stripe=return`,
    });
    expect(onboardingUrls("http://localhost:3000", STORE).return_url).toBe(
      `http://localhost:3000/dashboard/${STORE}/payments?stripe=return`,
    );
  });

  it("refuses anything that is not a bare http(s) origin, and a Store id that is not one", () => {
    for (const origin of ["https://app.shp0.dev/", "https://app.shp0.dev/x", "https://u:p@app.shp0.dev", "javascript:alert(1)", "", "null"]) {
      expect(() => onboardingUrls(origin, STORE), origin).toThrow();
    }
    expect(() => onboardingUrls("https://app.shp0.dev", "../other")).toThrow();
  });
});

describe("describeStripeAccount: what the Payments page says", () => {
  const connected = (fields: Partial<Extract<StripeAccountView, { connected: true }>> = {}): StripeAccountView => ({
    connected: true,
    accountId: "acct_test123",
    fresh: true,
    missing: false,
    summary: able,
    canTakePayments: true,
    cardPayments: "active",
    checkedAt: new Date("2026-09-29T00:00:00Z"),
    ...fields,
  });
  const page = (fields: Partial<StripeAccountPage>): StripeAccountPage => ({
    state: "active",
    action: null,
    warning: null,
    stale: false,
    notice: null,
    stripeDashboard: false,
    ...fields,
  });
  const summary = (fields: Partial<StripeAccountSummary>): StripeAccountSummary => ({
    ...able,
    canTakePayments: false,
    cardPayments: "restricted",
    ...fields,
  });

  it.each<[string, StripeAccountView, string | null, StripeAccountPage]>([
    ["not connected", { connected: false }, null, page({ state: "not_connected", action: "set_up" })],
    ["active", connected(), null, page({ state: "active", stripeDashboard: true })],
    [
      "active, Stripe needs more by a deadline",
      connected({ summary: { ...able, due: "currently_due", needsInfo: true } }),
      null,
      page({ state: "active", warning: "information_due", action: "update", stripeDashboard: true }),
    ],
    [
      "needs information",
      connected({ summary: summary({ needsInfo: true }), canTakePayments: false, cardPayments: "restricted" }),
      null,
      page({ state: "needs_info", action: "continue" }),
    ],
    [
      "in review",
      connected({ summary: summary({ cardPayments: "pending" }), canTakePayments: false, cardPayments: "pending" }),
      null,
      page({ state: "in_review" }),
    ],
    [
      "restricted by Stripe",
      connected({ summary: summary({ contactStripe: true }), canTakePayments: false }),
      null,
      page({ state: "restricted", stripeDashboard: true }),
    ],
    [
      "unsupported",
      connected({ summary: summary({ cardPayments: "unsupported" }), canTakePayments: false, cardPayments: "unsupported" }),
      null,
      page({ state: "unsupported", stripeDashboard: true }),
    ],
    [
      "closed",
      connected({ summary: summary({ closed: true }), canTakePayments: false }),
      null,
      page({ state: "closed" }),
    ],
    [
      "gone from Stripe",
      connected({ missing: true, summary: null, canTakePayments: false, cardPayments: null }),
      null,
      page({ state: "missing" }),
    ],
    [
      "no status reported",
      connected({ summary: summary({ cardPayments: null }), canTakePayments: false, cardPayments: null }),
      null,
      page({ state: "unknown", action: "continue" }),
    ],
    // Stripe could not be read: the stored status, marked stale.
    ["stale, able", connected({ fresh: false, summary: null }), null, page({ state: "active", stale: true, stripeDashboard: true })],
    [
      "stale, never read",
      connected({ fresh: false, summary: null, canTakePayments: false, cardPayments: null, checkedAt: null }),
      null,
      page({ state: "unknown", action: "continue", stale: true }),
    ],
    [
      "stale, pending",
      connected({ fresh: false, summary: null, canTakePayments: false, cardPayments: "pending" }),
      null,
      page({ state: "in_review", stale: true }),
    ],
    [
      "stale, restricted",
      connected({ fresh: false, summary: null, canTakePayments: false, cardPayments: "restricted" }),
      null,
      page({ state: "needs_info", action: "continue", stale: true }),
    ],
    // Where the Merchant came from only adds a note; the state is Stripe's.
    [
      "back from Stripe, still needs information",
      connected({ summary: summary({ needsInfo: true }), canTakePayments: false }),
      "return",
      page({ state: "needs_info", action: "continue", notice: "returned" }),
    ],
    ["back from Stripe, active", connected(), "return", page({ state: "active", notice: "returned", stripeDashboard: true })],
    [
      "expired link, can continue",
      connected({ summary: summary({ needsInfo: true }), canTakePayments: false }),
      "refresh",
      page({ state: "needs_info", action: "continue", notice: "link_expired" }),
    ],
    // No expired-link note when there is nothing to continue.
    ["expired link, active", connected(), "refresh", page({ state: "active", stripeDashboard: true })],
    ["an unknown note", connected(), "paid", page({ state: "active", stripeDashboard: true })],
  ])("%s", (_name, view, from, expected) => {
    expect(describeStripeAccount(view, from)).toEqual(expected);
  });
});

describe("describeFailure: what a log line says about a failure", () => {
  it("gives a Stripe error's type, code, status and request id, never its message", () => {
    const error = Stripe.errors.StripeError.generate({
      type: "invalid_request_error",
      code: "parameter_invalid",
      message: "Invalid email: someone@example.com",
      statusCode: 400,
      requestId: "req_123",
    } as Parameters<typeof Stripe.errors.StripeError.generate>[0]);

    const line = describeFailure(error);

    expect(line).toContain("parameter_invalid");
    expect(line).toContain("400");
    expect(line).toContain("req_123");
    expect(line).not.toContain("someone@example.com");
  });

  it("gives shp0's own errors their name and message", () => {
    expect(describeFailure(new TypeError("STRIPE_SECRET_KEY is not set"))).toBe("TypeError: STRIPE_SECRET_KEY is not set");
    expect(describeFailure("a string")).toBe("unknown error");
  });
});

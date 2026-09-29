import Stripe from "stripe";

import {
  getPaymentAccount,
  isUuid,
  recordStripeAccountStatus,
  savePaymentAccount,
  startStripeAccountRead,
  type CardPaymentsStatus,
  type StripeAccountRead,
} from "@shp0/db";

/** What Stripe's answer means for taking card payments. */
export type StripeAccountSummary = {
  /** The account is open, its merchant configuration applied, and card payments `active`. */
  canTakePayments: boolean;
  /** Stripe's card payments status; null when not reported, or a value shp0 does not know. */
  cardPayments: CardPaymentsStatus | null;
  closed: boolean;
  /** Stripe asks the Merchant for information, now or overdue. */
  needsInfo: boolean;
  /** The strictest deadline of what Stripe asks the Merchant for, if anything (not what Stripe itself is reviewing). */
  due: Deadline | null;
  /** When that is due: Stripe's time, given only when every requirement is the Merchant's. */
  dueAt: string | null;
};

type Deadline = "currently_due" | "eventually_due" | "past_due";
/** Deadlines from the least to the most strict. */
const DEADLINES: readonly Deadline[] = ["eventually_due", "currently_due", "past_due"];

export type StripeAccountDeps = {
  /**
   * The Stripe API client (the platform's key), created only when Stripe
   * must be asked.
   */
  stripe: () => Stripe;
};

/**
 * What Connect did. On `busy` and `unavailable`, try again: nothing was
 * linked, though an account Stripe created may have been saved.
 */
export type ConnectOutcome =
  /** Stripe's onboarding for the Store's account: send the Admin there. */
  | { kind: "onboarding"; url: string }
  /** The account can take card payments and Stripe needs nothing more. */
  | { kind: "active" }
  | { kind: "closed" }
  /** Stripe no longer has the saved account, or no longer lets shp0 use it. */
  | { kind: "missing" }
  /** Another Connect for the Store is creating its account right now. */
  | { kind: "busy" }
  /** Stripe could not be reached (no answer, 5xx, rate limited). */
  | { kind: "unavailable" };

/** The Store's Stripe account as the Payments page shows it. */
export type StripeAccountView =
  | { connected: false }
  | {
      connected: true;
      accountId: string;
      /** Read from Stripe just now; false when Stripe could not be read (the stored status is shown). */
      fresh: boolean;
      /** Stripe no longer has the account, or no longer lets shp0 read it. */
      missing: boolean;
      /** What Stripe reported, when fresh and not missing. */
      summary: StripeAccountSummary | null;
      /** The stored status, after this read if it was recorded. */
      canTakePayments: boolean;
      cardPayments: CardPaymentsStatus | null;
      checkedAt: Date | null;
    };

/** What shp0 reads of an account: its merchant configuration and requirements. */
export const ACCOUNT_READ = {
  include: ["configuration.merchant", "requirements"],
} satisfies Stripe.V2.Core.AccountRetrieveParams;

type StripeRequestOptions = { timeout: number; maxNetworkRetries: number };
/** Account creation retries under its key: a retry can only get the same account back. */
const CREATE: StripeRequestOptions = { timeout: 15_000, maxNetworkRetries: 2 };
const LINK: StripeRequestOptions = { timeout: 15_000, maxNetworkRetries: 1 };
const CONNECT_READ: StripeRequestOptions = { timeout: 10_000, maxNetworkRetries: 1 };
/** The Payments page's read: short, so the page is not held up. */
const PAGE_READ: StripeRequestOptions = { timeout: 5_000, maxNetworkRetries: 0 };

const CARD_PAYMENTS = new Set<string>(["active", "pending", "restricted", "unsupported"]);
const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,64}$/;

/**
 * The account creation request (ADR-0006 point 2): an Accounts v2 account
 * with the full Stripe Dashboard, Stripe collecting fees and carrying losses,
 * and card payments requested; the Store's id in shp0's metadata.
 *
 * A constant of the Store id: Stripe refuses a reused idempotency key with
 * other parameters, and nothing the Merchant typed is sent. Stripe's hosted
 * onboarding collects the rest.
 */
export function accountCreateParams(storeId: string) {
  return {
    dashboard: "full",
    defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    metadata: { shp0_store_id: storeId },
  } satisfies Stripe.V2.Core.AccountCreateParams;
}

/** The idempotency key of a Store's account creation (ADR-0006). */
export function accountIdempotencyKey(storeId: string): string {
  return `account:${storeId}`;
}

/**
 * Where Stripe sends the Admin back: the Store's Payments page on the origin
 * they are signed in on (refresh_url when a link expired or was used).
 * Throws unless `origin` is a bare http(s) origin and `storeId` a Store id.
 */
export function onboardingUrls(origin: string, storeId: string): { refresh_url: string; return_url: string } {
  if (!isUuid(storeId)) throw new Error("onboardingUrls needs a Store id");
  let parsed: URL | null = null;
  try {
    parsed = new URL(origin);
  } catch {
    // Reported below.
  }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== origin) {
    throw new Error("onboardingUrls needs the dashboard's origin, such as https://app.shp0.dev");
  }
  const page = `${origin}/dashboard/${storeId}/payments`;
  return { refresh_url: `${page}?stripe=refresh`, return_url: `${page}?stripe=return` };
}

/**
 * What an Accounts v2 account read with ACCOUNT_READ means for taking card
 * payments. Only an open account whose merchant configuration is applied and
 * whose card payments are `active` can take them; anything else, including a
 * status shp0 does not know or a missing configuration, cannot.
 *
 * What the Merchant owes comes from the requirements awaiting them: Stripe's
 * summary deadline covers every requirement, those Stripe itself is
 * reviewing too, so its time is used only when every requirement is theirs.
 */
export function summarizeStripeAccount(account: Stripe.V2.Core.Account): StripeAccountSummary {
  const merchant = account.configuration?.merchant;
  const cardPaymentsCapability = merchant?.capabilities?.card_payments;
  const status = cardPaymentsCapability?.status;
  const cardPayments = status !== undefined && CARD_PAYMENTS.has(status) ? (status as CardPaymentsStatus) : null;
  const details = cardPaymentsCapability?.status_details ?? [];
  const closed = account.closed === true;
  const entries = account.requirements?.entries ?? [];
  const merchantOwes = entries.filter((entry) => entry.awaiting_action_from === "user");
  const due = strictest(merchantOwes.map((entry) => entry.minimum_deadline?.status));
  const allMerchants = merchantOwes.length === entries.length;
  return {
    canTakePayments: !closed && merchant?.applied === true && cardPayments === "active",
    cardPayments,
    closed,
    needsInfo: details.some((detail) => detail.resolution === "provide_info") || due === "currently_due" || due === "past_due",
    due,
    dueAt: due !== null && allMerchants ? (account.requirements?.summary?.minimum_deadline?.time ?? null) : null,
  };
}

function strictest(deadlines: Array<string | undefined>): Deadline | null {
  let found = -1;
  for (const deadline of deadlines) found = Math.max(found, DEADLINES.indexOf(deadline as Deadline));
  return found < 0 ? null : DEADLINES[found]!;
}

/**
 * Connect (ADR-0006 point 2): send an Admin to Stripe's onboarding for the
 * Store's own Stripe account.
 *
 * - No saved account: create one (accountCreateParams, key
 *   account:<Store id>) and save its id at once, before onboarding. A
 *   concurrent or repeated attempt gets the same account back under the key;
 *   one already saved is used, and never replaced (an account created
 *   meanwhile is logged and left unused).
 * - A saved account: read it from Stripe first (and record what Stripe
 *   reports). A closed account, or one Stripe no longer has or no longer
 *   lets shp0 use, gets no link; one that can take payments and that Stripe
 *   asks nothing of the Merchant for gets none either.
 * - Otherwise: an onboarding link for the saved account, returning to the
 *   Store's Payments page (onboardingUrls).
 *
 * The Store id is used in lower case, so the same Store always has the same
 * key. Throws on Stripe's refusal (logged by the caller with its code) and on
 * a database failure: nothing is linked then. A create whose save failed is
 * logged with the account Stripe created, and the next Connect gets it back
 * while Stripe keeps the key.
 *
 * Stripe may keep a failed create's answer under the key too (#74): the next
 * Connects then get that answer back until Stripe drops the key. A failure is
 * logged with the key, for support; one Stripe marks as replayed is thrown, so
 * the Admin is told to contact support rather than to try again.
 */
export async function connectStripeAccount(
  deps: StripeAccountDeps,
  request: { storeId: string; origin: string },
): Promise<ConnectOutcome> {
  const storeId = request.storeId.toLowerCase();
  const urls = onboardingUrls(request.origin, storeId);
  const stripe = deps.stripe();

  let accountId: string;
  const read = await startStripeAccountRead({ storeId });
  if (read) {
    let result: AccountRead;
    try {
      result = await readAccount(stripe, read, CONNECT_READ);
    } catch (error) {
      if (isStripeFailure(error, "retryable", "in_use")) return { kind: "unavailable" };
      throw error;
    }
    if (result.missing) return { kind: "missing" };
    const { summary } = result;
    if (summary.closed) return { kind: "closed" };
    if (summary.canTakePayments && !summary.needsInfo) return { kind: "active" };
    accountId = read.accountId;
  } else {
    const key = accountIdempotencyKey(storeId);
    let created: Stripe.V2.Core.Account;
    try {
      created = await stripe.v2.core.accounts.create(accountCreateParams(storeId), { idempotencyKey: key, ...CREATE });
    } catch (error) {
      if (isStripeFailure(error, "in_use")) return { kind: "busy" };
      if (isStripeFailure(error, "retryable") && !isReplayed(error)) {
        console.warn(`Stripe could not create the Stripe account of Store ${storeId} (key ${key}): ${describeFailure(error)}`);
        return { kind: "unavailable" };
      }
      if (isReplayed(error)) {
        console.error(
          `Stripe answered the Stripe account creation of Store ${storeId} with the error it kept under key ${key} ` +
            `(${describeFailure(error)}): Connect cannot create the account until Stripe drops the key`,
        );
      }
      throw error;
    }
    if (!STRIPE_ACCOUNT_ID.test(created.id)) throw new Error("Stripe returned an account id shp0 cannot save");
    let saved: { accountId: string; saved: boolean };
    try {
      saved = await savePaymentAccount(storeId, created.id);
    } catch (error) {
      console.error(
        `Stripe account ${created.id} was created for Store ${storeId} but could not be saved: ${describeFailure(error)}`,
      );
      throw error;
    }
    if (saved.accountId !== created.id) {
      console.warn(
        `Stripe account ${created.id} was created for Store ${storeId}, which already has ${saved.accountId}; the new one is not used`,
      );
    }
    accountId = saved.accountId;
  }

  let link: Stripe.V2.Core.AccountLink;
  try {
    link = await stripe.v2.core.accountLinks.create(
      {
        account: accountId,
        use_case: { type: "account_onboarding", account_onboarding: { configurations: ["merchant"], ...urls } },
      } satisfies Stripe.V2.Core.AccountLinkCreateParams,
      LINK,
    );
  } catch (error) {
    if (isStripeFailure(error, "retryable", "in_use")) return { kind: "unavailable" };
    throw error;
  }
  // The link is a bearer credential for the Store's account: never stored or logged.
  if (!link.url.startsWith("https://")) throw new Error("Stripe returned an onboarding link that is not https");
  return { kind: "onboarding", url: link.url };
}

/**
 * The Store's Stripe account for the Payments page, read from Stripe (and
 * recorded) each time: `fresh` false, with the stored status, when Stripe
 * cannot be read. Stripe is not asked when the Store has no account.
 */
export async function syncStripeAccount(deps: StripeAccountDeps, storeId: string): Promise<StripeAccountView> {
  const read = await startStripeAccountRead({ storeId });
  if (!read) return { connected: false };

  let fresh = false;
  let missing = false;
  let summary: StripeAccountSummary | null = null;
  let stripe: Stripe | null = null;
  try {
    stripe = deps.stripe();
  } catch (error) {
    // No client (no key configured): the page still shows what Stripe last reported.
    console.warn(`Could not read Stripe account ${read.accountId} of Store ${storeId}: ${describeFailure(error)}`);
  }
  if (stripe) {
    try {
      const result = await readAccount(stripe, read, PAGE_READ);
      fresh = true;
      missing = result.missing;
      summary = result.missing ? null : result.summary;
    } catch (error) {
      if (!isStripeFailure(error, "retryable", "in_use", "refused")) throw error;
      console.warn(`Could not read Stripe account ${read.accountId} of Store ${storeId}: ${describeFailure(error)}`);
    }
  }

  const stored = await getPaymentAccount(storeId);
  return {
    connected: true,
    accountId: read.accountId,
    fresh,
    missing,
    summary,
    canTakePayments: stored?.chargesEnabled ?? false,
    cardPayments: stored?.cardPaymentsStatus ?? null,
    checkedAt: stored?.statusCheckedAt ?? null,
  };
}

export type AccountRead = { missing: true } | { missing: false; summary: StripeAccountSummary };

/**
 * Read a saved account from Stripe as the platform (no Stripe-Account), and
 * record what Stripe reports, ordered by the read's ticket. An account Stripe
 * no longer has (404), or no longer lets shp0 read (403: access revoked), is
 * recorded as unable to take payments. Other Stripe errors are thrown, and
 * nothing is recorded.
 */
export async function readAccount(
  stripe: Stripe,
  read: StripeAccountRead,
  options: StripeRequestOptions,
): Promise<AccountRead> {
  let account: Stripe.V2.Core.Account;
  try {
    account = await stripe.v2.core.accounts.retrieve(read.accountId, ACCOUNT_READ, options);
  } catch (error) {
    if (isStripeFailure(error, "missing", "no_access")) {
      await recordStripeAccountStatus(read, { cardPayments: null, canTakePayments: false });
      return { missing: true };
    }
    throw error;
  }
  const summary = summarizeStripeAccount(account);
  await recordStripeAccountStatus(read, { cardPayments: summary.cardPayments, canTakePayments: summary.canTakePayments });
  return { missing: false, summary };
}

/** How a Stripe request failed. */
export type StripeFailure = "in_use" | "retryable" | "missing" | "no_access" | "refused";

/**
 * Classify a Stripe error by its status, not its class (v2 maps some errors
 * to other classes than v1): a key in use (409 idempotency_key_in_use); a
 * failure a retry can fix (no answer, 5xx, 429, another 409, or 401, a
 * configuration fix); gone (404); not permitted (403); or a refusal. Null for
 * anything else.
 */
export function stripeFailure(error: unknown): StripeFailure | null {
  if (!(error instanceof Stripe.errors.StripeError)) return null;
  const status = error.statusCode;
  if (status === 409 && error.code === "idempotency_key_in_use") return "in_use";
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    status === undefined ||
    status >= 500 ||
    status === 429 ||
    status === 409 ||
    status === 401
  ) {
    return "retryable";
  }
  if (status === 404) return "missing";
  if (status === 403) return "no_access";
  return "refused";
}

function isStripeFailure(error: unknown, ...kinds: StripeFailure[]): boolean {
  const failure = stripeFailure(error);
  return failure !== null && kinds.includes(failure);
}

/** Stripe answered with the result it kept under the request's idempotency key (Idempotent-Replayed). */
function isReplayed(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && error.headers?.["idempotent-replayed"] === "true";
}

/**
 * A failure, for a log line. A Stripe error gives its type, code, status and
 * request id, never its message (which can quote what was sent). Anything
 * else is shp0's own (no key configured, a database error): its name and
 * message, so the log says what went wrong.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Stripe.errors.StripeError)) {
    return error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown error";
  }
  return [error.type, error.code, error.statusCode, error.requestId].filter((part) => part !== undefined).join(" ");
}

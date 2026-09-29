import type { StripeAccountView } from "./stripe-account";

/** Where the Store stands with its Stripe account, as the Payments page shows it. */
export type StripeAccountState =
  | "not_connected"
  /** Stripe asks the Merchant for information before card payments can start. */
  | "needs_info"
  /** Stripe is reviewing what the Merchant gave it. */
  | "in_review"
  /** Stripe has restricted card payments; the Merchant must contact Stripe. */
  | "restricted"
  /** Stripe cannot offer card payments to this business. */
  | "unsupported"
  | "closed"
  /** Stripe no longer has the saved account. */
  | "missing"
  /** The Store takes card payments. */
  | "active"
  /** Stripe has not said (not read yet, or no status reported). */
  | "unknown";

export type StripeAccountPage = {
  state: StripeAccountState;
  /** The Connect button: set up the account, continue its onboarding, or give Stripe what it asks for. */
  action: "set_up" | "continue" | "update" | null;
  /** The Store takes payments, but Stripe asks for information to keep it so. */
  warning: "information_due" | null;
  /** Stripe could not be read just now: this is what it last reported. */
  stale: boolean;
  /** Back from Stripe's onboarding, or its link expired (only when there is something to continue). */
  notice: "returned" | "link_expired" | null;
  /** Offer the Stripe Dashboard (the account has the full Dashboard). */
  stripeDashboard: boolean;
};

/**
 * What the Payments page says about the Store's Stripe account (ADR-0006),
 * from the view syncStripeAccount read. `from` is the page's `?stripe=`
 * (Stripe's return or refresh URL): it only adds a note, and the state is
 * always Stripe's.
 */
export function describeStripeAccount(view: StripeAccountView, from: string | null): StripeAccountPage {
  const page = describeState(view);
  const notice =
    from === "return" ? "returned" : from === "refresh" && page.action !== null ? "link_expired" : null;
  return { ...page, notice };
}

function describeState(view: StripeAccountView): Omit<StripeAccountPage, "notice"> {
  const base = { action: null, warning: null, stale: false, stripeDashboard: false } as const;
  if (!view.connected) return { ...base, state: "not_connected", action: "set_up" };
  if (view.missing) return { ...base, state: "missing" };

  const { summary } = view;
  if (view.fresh && summary) {
    if (summary.closed) return { ...base, state: "closed" };
    if (summary.canTakePayments) {
      const due = summary.needsInfo || summary.due === "currently_due" || summary.due === "past_due";
      return due
        ? { ...base, state: "active", warning: "information_due", action: "update", stripeDashboard: true }
        : { ...base, state: "active", stripeDashboard: true };
    }
    if (summary.cardPayments === "unsupported") return { ...base, state: "unsupported", stripeDashboard: true };
    if (summary.needsInfo) return { ...base, state: "needs_info", action: "continue" };
    if (summary.contactStripe) return { ...base, state: "restricted", stripeDashboard: true };
    if (summary.cardPayments === "pending") return { ...base, state: "in_review" };
    if (summary.cardPayments === null) return { ...base, state: "unknown", action: "continue" };
    return { ...base, state: "restricted", stripeDashboard: true };
  }

  // Stripe could not be read: what it last reported.
  const stale = { ...base, stale: true };
  if (view.canTakePayments) return { ...stale, state: "active", stripeDashboard: true };
  if (view.checkedAt === null) return { ...stale, state: "unknown", action: "continue" };
  switch (view.cardPayments) {
    case "pending":
      return { ...stale, state: "in_review" };
    case "unsupported":
      return { ...stale, state: "unsupported", stripeDashboard: true };
    case "restricted":
      return { ...stale, state: "needs_info", action: "continue" };
    default:
      return { ...stale, state: "unknown", action: "continue" };
  }
}

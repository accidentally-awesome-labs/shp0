import type { StripeAccountView } from "./stripe-account";

export type StripeAccountState =
  | "not_connected"
  | "needs_info"
  | "in_review"
  | "restricted"
  | "unsupported"
  | "closed"
  | "missing"
  | "active"
  | "unknown";

export type StripeAccountPage = {
  state: StripeAccountState;
  action: "set_up" | "continue" | "update" | null;
  warning: "information_due" | null;
  stale: boolean;
  notice: "returned" | "link_expired" | null;
  stripeDashboard: boolean;
};

// Today there is no Payments page: nothing tells an Admin where the Store stands.
export function describeStripeAccount(_view: StripeAccountView, _from: string | null): StripeAccountPage {
  return { state: "not_connected", action: "set_up", warning: null, stale: false, notice: null, stripeDashboard: false };
}

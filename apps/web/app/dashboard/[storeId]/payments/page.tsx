export const instant = false;

import Link from "next/link";

import { getStripeAccountStatus } from "@/app/actions/stripe-account";
import { authorizeStorePage } from "@/lib/current-store";
import { RequiresRole } from "@/app/dashboard/requires-role";
import { describeStripeAccount, type StripeAccountState } from "@shp0/payments";
import ConnectButton from "./connect-button";

/** What each state tells the Admin (describeStripeAccount decides which). */
const STATES: Record<StripeAccountState, { title: string; body: string; tone: string }> = {
  not_connected: {
    title: "Not set up",
    body: "Set up a Stripe account for this Store to take card payments. You'll give your business and bank details to Stripe on its site; shp0 never sees them.",
    tone: "border-gray-200",
  },
  needs_info: {
    title: "Stripe needs more information",
    body: "This Store can't take card payments until you give Stripe the details it asks for.",
    tone: "border-amber-300 bg-amber-50",
  },
  in_review: {
    title: "Stripe is reviewing your details",
    body: "This usually takes a few minutes. Card payments start as soon as Stripe approves them; this page shows Stripe's latest answer each time you open it.",
    tone: "border-blue-200 bg-blue-50",
  },
  restricted: {
    title: "Card payments are restricted",
    body: "Stripe has restricted card payments on this account. Open your Stripe Dashboard, or contact Stripe support, to resolve it.",
    tone: "border-red-300 bg-red-50",
  },
  unsupported: {
    title: "Stripe can't offer card payments to this business",
    body: "Stripe doesn't support card payments for this business's country or type. Contact Stripe support.",
    tone: "border-red-300 bg-red-50",
  },
  closed: {
    title: "This Store's Stripe account is closed",
    body: "Customers can't pay online. A Store keeps the Stripe account it was set up with; contact shp0 support.",
    tone: "border-red-300 bg-red-50",
  },
  missing: {
    title: "Stripe can't find this Store's Stripe account",
    body: "Customers can't pay online. A Store keeps the Stripe account it was set up with; contact shp0 support.",
    tone: "border-red-300 bg-red-50",
  },
  active: {
    title: "Taking card payments",
    body: "Customers pay for their Orders on this Store's own Stripe account. Stripe charges its processing fees; shp0 takes no commission. Manage payouts, refunds and disputes in your Stripe Dashboard.",
    tone: "border-green-300 bg-green-50",
  },
  unknown: {
    title: "Not checked yet",
    body: "Stripe hasn't reported on this account yet. Continue with Stripe to finish setting it up.",
    tone: "border-gray-200",
  },
};

const ACTION_LABELS = {
  set_up: "Set up payments with Stripe",
  continue: "Continue with Stripe",
  update: "Update details with Stripe",
} as const;

/**
 * The Store's Payments page (ADR-0006): where the Store stands with its own
 * Stripe account, read from Stripe each time the page is opened, and the
 * Connect button. Stripe's onboarding returns here (`?stripe=return`, or
 * `?stripe=refresh` for an expired link): that only adds a note, since the
 * state always comes from Stripe.
 */
export default async function PaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId } = await params;
  // Connecting the Store's Stripe account is a Store setting: Admin and above.
  // A non-member gets the not-found page.
  const access = await authorizeStorePage(storeId, "settings.manage");
  if (access.status !== "ok") return <RequiresRole role={access.required} storeId={storeId} />;

  const from = (await searchParams).stripe;
  const view = await getStripeAccountStatus(storeId);
  const page = describeStripeAccount(view, typeof from === "string" ? from : null);
  const state = STATES[page.state];

  return (
    <main className="mx-auto max-w-2xl p-8">
      <Link href={`/dashboard/${storeId}`} className="text-sm text-gray-500 hover:text-black">
        ← Store
      </Link>
      <h1 className="mt-4 text-2xl font-bold">Payments</h1>
      <p className="mt-1 text-sm text-gray-500">
        Customers pay on this Store's own Stripe account. Stripe charges its processing fees; shp0 takes no commission.
      </p>

      {page.notice === "returned" && (
        <p role="status" className="mt-6 rounded bg-blue-50 p-3 text-sm text-blue-700">
          Back from Stripe. This is what Stripe reports now
          {page.state === "active" ? "." : "; if you just finished, Stripe may still be reviewing your details."}
        </p>
      )}
      {page.notice === "link_expired" && (
        <p role="status" className="mt-6 rounded bg-blue-50 p-3 text-sm text-blue-700">
          That Stripe link expired or was already used. Continue with Stripe to get a new one.
        </p>
      )}
      {page.stale && (
        <p role="status" className="mt-6 rounded bg-gray-100 p-3 text-sm text-gray-700">
          Couldn't reach Stripe just now. This shows what Stripe last reported
          {view.connected && view.checkedAt ? ` (${view.checkedAt.toUTCString()})` : ""}.
        </p>
      )}

      <section className={`mt-6 rounded-lg border p-6 ${state.tone}`}>
        <h2 className="font-semibold">{state.title}</h2>
        <p className="mt-2 text-sm text-gray-700">{state.body}</p>
        {page.warning === "information_due" && (
          <p className="mt-3 text-sm text-amber-800">
            Stripe needs more information
            {view.connected && view.summary?.dueAt ? ` by ${new Date(view.summary.dueAt).toUTCString()}` : ""}. Card
            payments may be paused if it isn't provided.
          </p>
        )}
        {page.action && (
          <div className="mt-4">
            <ConnectButton storeId={storeId} label={ACTION_LABELS[page.action]} />
          </div>
        )}
        {page.stripeDashboard && (
          <a
            href="https://dashboard.stripe.com/"
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-block text-sm underline"
          >
            Open Stripe Dashboard
          </a>
        )}
        {page.state === "not_connected" && (
          <p className="mt-4 text-xs text-gray-500">Using a Stripe account you already have isn't available yet.</p>
        )}
      </section>

      {view.connected && <p className="mt-4 font-mono text-xs text-gray-400">Stripe account {view.accountId}</p>}
    </main>
  );
}

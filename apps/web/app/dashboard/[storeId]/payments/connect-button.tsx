"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { connectStripeAccountAction, type ConnectResult } from "@/app/actions/stripe-account";

const ERRORS: Record<Extract<ConnectResult, { kind: "error" }>["reason"], string> = {
  busy: "Stripe is still setting up this Store's account. Try again in a few seconds.",
  unavailable: "Couldn't reach Stripe. Try again in a few minutes; if it keeps failing, contact shp0 support.",
  closed: "This Store's Stripe account is closed.",
  missing: "shp0 can no longer use this Store's Stripe account. Contact shp0 support.",
  failed: "Stripe couldn't set up the account. Try again later; if it keeps failing, contact shp0 support.",
};

/**
 * The Payments page's Connect button. It follows Connect's answer in the
 * browser: to Stripe's onboarding, or a fresh look at this page.
 */
export default function ConnectButton({ storeId, label }: { storeId: string; label: string }) {
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setOpening(true);
    setError(null);
    try {
      const result = await connectStripeAccountAction(storeId);
      if (result.kind === "stripe") {
        // Stay disabled until Stripe's page replaces this one.
        window.location.assign(result.url);
        return;
      }
      if (result.kind === "active") router.refresh();
      else setError(ERRORS[result.reason]);
    } catch {
      // A thrown error's message is a digest in production.
      setError(ERRORS.failed);
    }
    setOpening(false);
  }

  return (
    <div>
      <button
        type="button"
        onClick={connect}
        disabled={opening}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {opening ? "Opening Stripe…" : label}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

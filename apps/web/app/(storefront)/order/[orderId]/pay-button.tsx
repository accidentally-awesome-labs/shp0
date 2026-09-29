"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { payOrderAction } from "@/app/actions/stripe";

/**
 * The Order page's Pay button. It follows Pay's answer in the browser: to
 * Stripe's page, or back to this Order with a note (payOrderAction says why
 * it does not redirect itself).
 */
export default function PayButton({ orderId, label }: { orderId: string; label: string }) {
  const router = useRouter();
  const [opening, setOpening] = useState(false);

  async function pay() {
    setOpening(true);
    let note: string | null = "failed";
    try {
      const result = await payOrderAction(orderId);
      if (result.kind === "stripe") {
        // Stay disabled until Stripe's page replaces this one.
        window.location.assign(result.url);
        return;
      }
      note = result.note;
    } catch {
      // A thrown error's message is a digest in production: say it failed.
    }
    const orderPath = `/order/${encodeURIComponent(orderId)}`;
    router.replace(note ? `${orderPath}?checkout=${note}` : orderPath);
    router.refresh();
    setOpening(false);
  }

  return (
    <button
      type="button"
      onClick={pay}
      disabled={opening}
      className="w-full rounded bg-black px-4 py-3 text-white disabled:opacity-50"
    >
      {opening ? "Opening secure payment…" : label}
    </button>
  );
}

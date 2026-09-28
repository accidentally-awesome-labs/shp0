"use client";

import { useFormStatus } from "react-dom";

/** The Order page's Pay button: disabled while Pay opens Stripe Checkout. */
export default function PayButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded bg-black px-4 py-3 text-white disabled:opacity-50"
    >
      {pending ? "Opening secure payment…" : label}
    </button>
  );
}

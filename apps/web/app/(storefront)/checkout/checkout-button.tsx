"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { checkoutAction } from "@/app/actions/checkout";

export default function CheckoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCheckout() {
    setError(null);
    setLoading(true);
    try {
      const result = await checkoutAction();
      router.push(`/order/${result.orderId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <button
        onClick={handleCheckout}
        disabled={loading}
        className="w-full rounded bg-black px-4 py-3 text-white disabled:opacity-50"
      >
        {loading ? "Placing order…" : "Place order"}
      </button>
    </div>
  );
}

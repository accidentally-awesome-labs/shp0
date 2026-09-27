"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { checkoutAction } from "@/app/actions/checkout";

export default function CheckoutButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "placing" | "placed">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleCheckout() {
    setError(null);
    setState("placing");
    try {
      const result = await checkoutAction();
      if (!result.ok) {
        setError(result.error);
        setState("idle");
        return;
      }
      // Stay disabled until the Order page replaces this one: the Cart is
      // consumed, so a second click would only report an error.
      setState("placed");
      router.push(`/order/${result.orderId}`);
    } catch {
      // A thrown error's message is a digest in production: say something useful.
      setError("Checkout failed. Please try again.");
      setState("idle");
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-2 text-sm text-red-600">
          {error}{" "}
          <a href="/cart" className="underline">
            Review your cart
          </a>
        </p>
      )}
      <button
        onClick={handleCheckout}
        disabled={state !== "idle"}
        className="w-full rounded bg-black px-4 py-3 text-white disabled:opacity-50"
      >
        {state === "placed" ? "Order placed…" : state === "placing" ? "Placing order…" : "Place order"}
      </button>
    </div>
  );
}

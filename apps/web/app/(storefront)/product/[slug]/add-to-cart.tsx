"use client";

import { useState } from "react";
import { addToCart } from "@/app/actions/cart";

export default function AddToCartButton({
  variantId,
  disabled,
  outOfStock,
}: {
  variantId: string;
  disabled: boolean;
  outOfStock: boolean;
}) {
  const [added, setAdded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setPending(true);
    try {
      const result = await addToCart(variantId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAdded(true);
      setTimeout(() => setAdded(false), 1500);
    } catch {
      setError("Could not add this to your cart. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={disabled || pending}
        className="mt-4 w-full rounded bg-black px-4 py-3 text-white disabled:bg-gray-300"
      >
        {added ? "Added!" : outOfStock ? "Out of stock" : "Add to cart"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

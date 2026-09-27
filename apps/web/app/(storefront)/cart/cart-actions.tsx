"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateCartItem, removeCartItem, type CartActionResult } from "@/app/actions/cart";

export default function CartActions({
  variantId,
  quantity,
}: {
  variantId: string;
  quantity: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<CartActionResult>) {
    setError(null);
    setPending(true);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not update your cart. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          onClick={() => run(() => updateCartItem(variantId, Math.max(1, quantity - 1)))}
          disabled={pending}
          className="rounded border px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
        >
          −
        </button>
        <span className="w-8 text-center text-sm">{quantity}</span>
        <button
          onClick={() => run(() => updateCartItem(variantId, quantity + 1))}
          disabled={pending}
          className="rounded border px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
        >
          +
        </button>
        <button
          onClick={() => run(() => removeCartItem(variantId))}
          disabled={pending}
          className="ml-2 text-sm text-red-500 hover:underline disabled:opacity-50"
        >
          Remove
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

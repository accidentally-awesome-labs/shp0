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

  async function handleClick() {
    await addToCart(variantId);
    setAdded(true);
    setTimeout(() => setAdded(false), 1500);
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className="mt-4 w-full rounded bg-black px-4 py-3 text-white disabled:bg-gray-300"
    >
      {added ? "Added!" : outOfStock ? "Out of stock" : "Add to cart"}
    </button>
  );
}


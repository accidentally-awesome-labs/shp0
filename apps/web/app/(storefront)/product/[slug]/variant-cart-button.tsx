"use client";

import { useState } from "react";
import { addToCart } from "@/app/actions/cart";

type Variant = {
  id: string;
  title: string;
  priceCents: number;
  inventory: number;
};

export default function VariantCartButton({ variants }: { variants: Variant[] }) {
  const [selectedId, setSelectedId] = useState("");
  const [added, setAdded] = useState(false);

  const selected = variants.find((v) => v.id === selectedId);
  const outOfStock = selected ? selected.inventory <= 0 : true;

  async function handleClick() {
    if (!selectedId) return;
    await addToCart(selectedId);
    setAdded(true);
    setTimeout(() => setAdded(false), 1500);
  }

  return (
    <button
      onClick={handleClick}
      disabled={!selectedId || outOfStock}
      className="mt-4 w-full rounded bg-black px-4 py-3 text-white disabled:bg-gray-300"
    >
      {added ? "Added!" : outOfStock ? "Out of stock" : "Add to cart"}
    </button>
  );
}


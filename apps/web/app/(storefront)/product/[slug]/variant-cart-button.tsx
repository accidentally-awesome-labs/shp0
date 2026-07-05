"use client";

import { useState } from "react";

type Variant = {
  id: string;
  title: string;
  priceCents: number;
  inventory: number;
};

export default function VariantCartButton({ variants }: { variants: Variant[] }) {
  const [selectedId, setSelectedId] = useState("");

  const selected = variants.find((v) => v.id === selectedId);
  const outOfStock = selected ? selected.inventory <= 0 : true;

  return (
    <button
      disabled={!selectedId || outOfStock}
      className="mt-4 w-full rounded bg-black px-4 py-3 text-white disabled:bg-gray-300"
    >
      {outOfStock ? "Out of stock" : "Add to cart"}
    </button>
  );
}

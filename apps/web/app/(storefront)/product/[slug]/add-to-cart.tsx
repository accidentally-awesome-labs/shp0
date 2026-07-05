"use client";

export default function AddToCartButton({
  variantId,
  disabled,
  outOfStock,
}: {
  variantId: string;
  disabled: boolean;
  outOfStock: boolean;
}) {
  return (
    <button
      disabled={disabled}
      data-variant-id={variantId}
      className="mt-4 w-full rounded bg-black px-4 py-3 text-white disabled:bg-gray-300"
    >
      {outOfStock ? "Out of stock" : "Add to cart"}
    </button>
  );
}

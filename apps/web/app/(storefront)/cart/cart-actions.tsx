"use client";

import { updateCartItem, removeCartItem } from "@/app/actions/cart";
import { useRouter } from "next/navigation";

export default function CartActions({
  variantId,
  quantity,
}: {
  variantId: string;
  quantity: number;
}) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={async () => {
          await updateCartItem(variantId, Math.max(1, quantity - 1));
          router.refresh();
        }}
        className="rounded border px-3 py-1 text-sm hover:bg-gray-100"
      >
        −
      </button>
      <span className="w-8 text-center text-sm">{quantity}</span>
      <button
        onClick={async () => {
          await updateCartItem(variantId, quantity + 1);
          router.refresh();
        }}
        className="rounded border px-3 py-1 text-sm hover:bg-gray-100"
      >
        +
      </button>
      <button
        onClick={async () => {
          await removeCartItem(variantId);
          router.refresh();
        }}
        className="ml-2 text-sm text-red-500 hover:underline"
      >
        Remove
      </button>
    </div>
  );
}

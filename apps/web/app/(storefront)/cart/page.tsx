import { Suspense } from "react";
import { notFound } from "next/navigation";

import { resolveStorefrontStore } from "@/lib/current-store";
import { getDbCart, formatMoney, listPublishedProducts } from "@shp0/db";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import CartActions from "./cart-actions";

export const instant = false;

async function CartView() {
  const storeId = await resolveStorefrontStore();
  if (!storeId) notFound();

  // Get the anon cart token (same logic as the cart action).
  const cookieStore = await cookies();
  let token = cookieStore.get("shp0_cart_token")?.value;
  if (!token) {
    token = randomUUID();
  }

  const cart = await getDbCart(storeId, token);

  // Fetch prices for the cart items.
  const products = await listPublishedProducts(storeId);
  const variantPrices = new Map<string, { priceCents: number; title: string }>();
  // We need variant-level detail — query via platform for pricing.
  // For now, use the minPriceCents from products as a fallback.
  // Real implementation will join variants.

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold">Your Cart</h1>

      {cart.lines.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed p-12 text-center text-gray-500">
          Your cart is empty.{" "}
          <a href="/" className="underline">
            Browse products
          </a>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {cart.lines.map((line) => (
            <div
              key={line.variantId}
              className="flex items-center justify-between rounded-lg border p-4"
            >
              <div>
                <p className="font-medium">Variant: {line.variantId.slice(0, 8)}…</p>
                <p className="text-sm text-gray-500">Qty: {line.quantity}</p>
              </div>
              <CartActions variantId={line.variantId} quantity={line.quantity} />
            </div>
          ))}

          <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">
            Cart subtotal is computed at checkout from live Variant prices (ADR-0002).
          </div>
        </div>
      )}
    </div>
  );
}

export default function CartPage() {
  return (
    <main className="min-h-screen">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-24 text-gray-400">
            Loading cart…
          </div>
        }
      >
        <CartView />
      </Suspense>
    </main>
  );
}

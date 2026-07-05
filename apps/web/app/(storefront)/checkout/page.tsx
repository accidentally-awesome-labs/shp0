import { Suspense } from "react";
import { notFound } from "next/navigation";

import { resolveStorefrontStore } from "@/lib/current-store";
import { getDbCart, formatMoney } from "@shp0/db";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import CheckoutButton from "./checkout-button";

export const instant = false;

async function CheckoutView() {
  const storeId = await resolveStorefrontStore();
  if (!storeId) notFound();

  const cookieStore = await cookies();
  let token = cookieStore.get("shp0_cart_token")?.value;
  if (!token) {
    token = randomUUID();
  }

  const cart = await getDbCart(storeId, token);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold">Checkout</h1>

      {cart.lines.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed p-12 text-center text-gray-500">
          Your cart is empty.{" "}
          <a href="/" className="underline">
            Browse products
          </a>
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="rounded-lg border p-6">
            <h2 className="font-semibold">Order Summary</h2>
            <div className="mt-4 space-y-2">
              {cart.lines.map((line) => (
                <div
                  key={line.variantId}
                  className="flex justify-between text-sm"
                >
                  <span className="text-gray-600">
                    {line.variantId.slice(0, 8)}… × {line.quantity}
                  </span>
                  <span className="text-gray-500">
                    Priced at checkout
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 border-t pt-4 text-sm text-gray-500">
              Total computed from live Variant prices when you place the order.
            </div>
          </div>

          <CheckoutButton />

          <p className="text-center text-xs text-gray-400">
            This is a test checkout (no payment yet). Your order will be created
            in <code className="rounded bg-gray-100 px-1">payment: pending</code>.
          </p>
        </div>
      )}
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <main className="min-h-screen">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-24 text-gray-400">
            Loading checkout…
          </div>
        }
      >
        <CheckoutView />
      </Suspense>
    </main>
  );
}

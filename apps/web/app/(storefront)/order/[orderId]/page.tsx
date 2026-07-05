import { Suspense } from "react";
import { notFound } from "next/navigation";
import { resolveStorefrontStore } from "@/lib/current-store";
import { getOrder, formatMoney, isOrderOpen } from "@shp0/db";

export const instant = false;

async function OrderView({ orderId }: { orderId: string }) {
  const storeId = await resolveStorefrontStore();
  if (!storeId) notFound();

  const order = await getOrder(storeId, orderId);

  if (!order) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold">Order Confirmed</h1>
      <p className="mt-1 text-sm text-gray-500">Order #{order.id.slice(0, 8)}</p>

      <div className="mt-6 rounded-lg border p-6">
        <div className="flex gap-4 text-sm">
          <div>
            <p className="text-gray-500">Payment</p>
            <p className="mt-1 font-medium capitalize">{order.paymentStatus}</p>
          </div>
          <div>
            <p className="text-gray-500">Fulfillment</p>
            <p className="mt-1 font-medium capitalize">{order.fulfillmentStatus}</p>
          </div>
          <div>
            <p className="text-gray-500">Status</p>
            <p className="mt-1 font-medium">
              {isOrderOpen({ payment: order.paymentStatus as any, fulfillment: order.fulfillmentStatus as any })
                ? "Open"
                : "Closed"}
            </p>
          </div>
        </div>

        <div className="mt-6 border-t pt-4">
          <h2 className="text-sm font-semibold">Items</h2>
          <div className="mt-2 space-y-2">
            {order.lines.map((line, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-gray-600">
                  {line.variantId.slice(0, 8)}… × {line.quantity}
                </span>
                <span className="text-gray-500">
                  {formatMoney(line.unitPriceCents * line.quantity, "USD") as string}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-between border-t pt-4 font-medium">
            <span>Total</span>
            <span>{formatMoney(order.totalCents, "USD") as string}</span>
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-lg bg-blue-50 p-4 text-sm text-blue-700">
        Payment integration comes in a later slice. This order is{" "}
        <strong>pending payment</strong> — no charge has been made.
      </div>

      <a href="/" className="mt-6 block text-center text-sm text-gray-500 underline">
        Continue shopping
      </a>
    </div>
  );
}

export default async function OrderPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  return (
    <main className="min-h-screen">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-24 text-gray-400">
            Loading order…
          </div>
        }
      >
        <OrderView orderId={orderId} />
      </Suspense>
    </main>
  );
}

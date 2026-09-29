import { Suspense } from "react";
import { notFound } from "next/navigation";
import { readCartToken } from "@/lib/cart-token";
import { resolveStorefrontStore } from "@/lib/current-store";
import { getStripe } from "@/lib/stripe";
import { getStorefrontOrder, formatMoney, isOrderOpen, type RefundReason } from "@shp0/db";
import {
  describeOrderPayment,
  getCheckoutAvailability,
  type CheckoutAvailability,
  type OrderPaymentNotice,
} from "@shp0/payments";
import PayButton from "./pay-button";

export const instant = false;

type Tone = "success" | "info" | "warning";

const TONES: Record<Tone, string> = {
  success: "bg-green-50 text-green-800",
  info: "bg-blue-50 text-blue-700",
  warning: "bg-amber-50 text-amber-800",
};

/** The Customer's reading of each notice (describeOrderPayment decides which). */
function noticeText(notice: OrderPaymentNotice, refundReason: RefundReason | null): { tone: Tone; text: string } {
  const why =
    refundReason === "insufficient_inventory"
      ? "An item sold out before your payment went through"
      : "Your payment could not be applied to this order";
  switch (notice) {
    case "paid":
      return { tone: "success", text: "Payment received. Thank you for your order!" };
    case "refunded":
      return { tone: "warning", text: `${why}, so it has been refunded in full.` };
    case "refund_pending":
      return {
        tone: "warning",
        text: `${why}, so it is being refunded in full. If the refund hasn't reached you in a few days, please contact the store.`,
      };
    case "refund_failed":
      return {
        tone: "warning",
        text: `${why}, and it has not been refunded yet. Please contact the store about your refund.`,
      };
    case "confirming":
      return { tone: "info", text: "Thank you! We're confirming your payment, which can take a moment." };
    case "processing":
      return {
        tone: "info",
        text: "Your payment is being processed. This page will show the order as paid once it goes through.",
      };
    case "failed":
      return { tone: "info", text: "We couldn't start your payment. Please try again." };
    case "in_progress":
      return { tone: "info", text: "Your payment page is being prepared. Please try again in a moment." };
    case "item_unavailable":
      return {
        tone: "info",
        text: "An item in this order is no longer available, so it can't be paid for online. Please contact the store.",
      };
    case "out_of_stock":
      return { tone: "info", text: "An item in this order is out of stock, so it can't be paid for right now." };
    case "not_chargeable":
      return { tone: "info", text: "This order can't be paid for online. Please contact the store." };
    case "payments_not_set_up":
      return { tone: "info", text: "This store isn't taking online payments yet." };
  }
}

/**
 * The Order page. Only the request carrying the cart token that placed the
 * Order (its own shp0_cart_token cookie) sees it; anyone else, with the Order
 * id alone, gets the same not-found as for an Order that does not exist
 * (getStorefrontOrder). Lines show titles, not Variant ids.
 *
 * A pending Order that Pay would send to Stripe has a Pay button
 * (payOrderAction, ADR-0006); otherwise the page says why not, including a
 * payment still processing or refunded automatically. describeOrderPayment
 * decides, from the Order's state; `?checkout=` only adds a note.
 */
async function OrderView({
  orderId,
  searchParams,
}: {
  orderId: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const storeId = await resolveStorefrontStore();
  if (!storeId) notFound();

  const cartToken = await readCartToken();
  const order = await getStorefrontOrder(storeId, orderId, cartToken);
  if (!order) notFound();

  const checkoutParam = (await searchParams).checkout;
  const note = typeof checkoutParam === "string" ? checkoutParam : null;
  let availability: CheckoutAvailability | null = null;
  if (order.paymentStatus === "pending") {
    try {
      availability = await getCheckoutAvailability({ stripe: getStripe }, { storeId, orderId: order.id, cartToken });
    } catch (error) {
      // Offer Pay, which checks again.
      console.error(
        `Could not read the payment state of Order ${order.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const payment = describeOrderPayment(order, availability, note);
  const notice = payment.notice && noticeText(payment.notice, order.payment?.refundReason ?? null);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold">
        {order.paymentStatus === "paid" ? "Order confirmed" : order.paymentStatus === "pending" ? "Order placed" : "Order"}
      </h1>
      <p className="mt-1 text-sm text-gray-500">Order #{order.id.slice(0, 8)}</p>

      {notice && (
        <div role="status" className={`mt-6 rounded-lg p-4 text-sm ${TONES[notice.tone]}`}>
          {notice.text}
          {payment.refresh && (
            <>
              {" "}
              <a href={`/order/${order.id}`} className="underline">
                Refresh
              </a>
            </>
          )}
        </div>
      )}

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
                  {lineTitle(line)} × {line.quantity}
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

      {payment.payable && (
        <div className="mt-6">
          <PayButton orderId={order.id} label={`Pay ${formatMoney(order.totalCents, "USD") as string}`} />
          <p className="mt-2 text-center text-xs text-gray-500">You'll pay securely on Stripe.</p>
        </div>
      )}

      <a href="/" className="mt-6 block text-center text-sm text-gray-500 underline">
        Continue shopping
      </a>
    </div>
  );
}

function lineTitle(line: { productTitle: string | null; variantTitle: string | null }): string {
  if (line.productTitle === null) return "Item no longer available";
  if (line.variantTitle === null || line.variantTitle === "Default") return line.productTitle;
  return `${line.productTitle} — ${line.variantTitle}`;
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
        <OrderView orderId={orderId} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

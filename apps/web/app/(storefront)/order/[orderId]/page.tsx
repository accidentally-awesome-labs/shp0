import { Suspense } from "react";
import { notFound } from "next/navigation";
import { payOrderAction } from "@/app/actions/stripe";
import { readCartToken } from "@/lib/cart-token";
import { resolveStorefrontStore } from "@/lib/current-store";
import { getStorefrontOrder, formatMoney, isOrderOpen, type StorefrontOrder } from "@shp0/db";
import { getCheckoutAvailability, type CheckoutAvailability, type CheckoutBlock } from "@shp0/payments";
import PayButton from "./pay-button";

export const instant = false;

/** Why an Order cannot be paid online, as the Customer reads it. */
const BLOCK_MESSAGES: Record<CheckoutBlock | "failed", string> = {
  not_found: "This order could not be found.",
  not_pending: "This order no longer needs a payment.",
  item_unavailable:
    "An item in this order is no longer available, so it can't be paid for online. Please contact the store.",
  out_of_stock: "An item in this order is out of stock, so it can't be paid for right now.",
  not_chargeable: "This order can't be paid for online. Please contact the store.",
  payments_not_set_up: "This store isn't taking online payments yet.",
  processing: "Your payment is being processed. This page will show the order as paid once it goes through.",
  in_progress: "Your payment page is being prepared. Please try again in a moment.",
  failed: "We couldn't start your payment. Please try again.",
};

/**
 * What `?checkout=` may say about a moment ago: back from Stripe (its
 * success URL), or a Pay that could not open Stripe for a passing reason.
 * Any other reason is read from the Order itself, as it is now.
 */
type CheckoutNote = "returned" | "processing" | "in_progress" | "failed";
const CHECKOUT_NOTES = new Set<string>(["returned", "processing", "in_progress", "failed"]);

type Notice = { tone: "success" | "info" | "warning"; text: string };

const TONES: Record<Notice["tone"], string> = {
  success: "bg-green-50 text-green-800",
  info: "bg-blue-50 text-blue-700",
  warning: "bg-amber-50 text-amber-800",
};

/**
 * The Order page. Only the request carrying the cart token that placed the
 * Order (its own shp0_cart_token cookie) sees it; anyone else, with the Order
 * id alone, gets the same not-found as for an Order that does not exist
 * (getStorefrontOrder). Lines show titles, not Variant ids.
 *
 * A pending Order that can be paid online has a Pay button (payOrderAction,
 * ADR-0006); otherwise the page says why it cannot be paid. It also says
 * when a payment was refunded automatically.
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
  const note =
    typeof checkoutParam === "string" && CHECKOUT_NOTES.has(checkoutParam) ? (checkoutParam as CheckoutNote) : null;
  const availability =
    order.paymentStatus === "pending"
      ? await getCheckoutAvailability({ storeId, orderId: order.id, cartToken })
      : null;

  const notice = paymentNotice(order, note, availability);
  // Back from Stripe, or a payment still processing: wait rather than Pay again.
  const waiting = order.payment === null && (note === "returned" || note === "processing");
  const payable = availability?.available === true && !waiting;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold">
        {order.paymentStatus === "paid" ? "Order confirmed" : order.paymentStatus === "pending" ? "Order placed" : "Order"}
      </h1>
      <p className="mt-1 text-sm text-gray-500">Order #{order.id.slice(0, 8)}</p>

      {notice && (
        <div role="status" className={`mt-6 rounded-lg p-4 text-sm ${TONES[notice.tone]}`}>
          {notice.text}
          {waiting && (
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

      {payable && (
        <form action={payOrderAction.bind(null, order.id)} className="mt-6">
          <PayButton label={`Pay ${formatMoney(order.totalCents, "USD") as string}`} />
          <p className="mt-2 text-center text-xs text-gray-500">You'll pay securely on Stripe.</p>
        </form>
      )}

      <a href="/" className="mt-6 block text-center text-sm text-gray-500 underline">
        Continue shopping
      </a>
    </div>
  );
}

/** What the page tells the Customer about paying this Order, if anything. */
function paymentNotice(
  order: StorefrontOrder,
  note: CheckoutNote | null,
  availability: CheckoutAvailability | null,
): Notice | null {
  if (order.paymentStatus === "paid") return { tone: "success", text: "Payment received. Thank you for your order!" };
  if (order.paymentStatus !== "pending") return null;

  // The current session's payment was not honoured, and is refunded in full.
  if (order.payment && order.payment.status !== "paid") {
    const why =
      order.payment.refundReason === "insufficient_inventory"
        ? "An item sold out before your payment went through"
        : "Your payment could not be applied to this order";
    const when = order.payment.status === "refunded" ? "has been" : "will be";
    return { tone: "warning", text: `${why}, so it ${when} refunded in full.` };
  }

  if (note === "returned") {
    return { tone: "info", text: "Thank you! We're confirming your payment, which can take a moment." };
  }
  if (note !== null) return { tone: "info", text: BLOCK_MESSAGES[note] };
  if (availability && !availability.available) return { tone: "info", text: BLOCK_MESSAGES[availability.reason] };
  return null;
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

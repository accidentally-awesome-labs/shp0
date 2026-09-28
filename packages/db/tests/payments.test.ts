import { describe, it, expect } from "vitest";

import {
  computeApplicationFee,
  buildCheckoutSessionParams,
} from "../src/payments";

/**
 * Issue #10 — Payment fee math + Stripe Checkout Session param builder.
 * These are pure functions — no I/O, no Stripe API calls.
 *
 * computeApplicationFee: basis points → cents (integer math, ADR-0004).
 * buildCheckoutSessionParams: order lines → Stripe line_items + application_fee.
 */
describe("Payment fee math (Issue #10)", () => {
  describe("computeApplicationFee", () => {
    it("computes fee from basis points (250 bps = 2.5%)", () => {
      // $100.00 = 10000 cents, 2.5% = 250 cents
      expect(computeApplicationFee(10000, 250)).toBe(250);
    });

    it("computes fee for a typical order ($29.99, 3% = 300bps)", () => {
      // 2999 cents * 0.03 = 89.97 → floored to 89 cents
      expect(computeApplicationFee(2999, 300)).toBe(89);
    });

    it("returns 0 for 0 bps (no commission)", () => {
      expect(computeApplicationFee(10000, 0)).toBe(0);
    });

    it("rounds down (floor) to avoid overcharging the platform fee", () => {
      // 100 cents * 257 bps = 2.57 → floor to 2
      expect(computeApplicationFee(100, 257)).toBe(2);
    });

    it("rejects negative bps", () => {
      expect(() => computeApplicationFee(10000, -1)).toThrow();
    });

    it("rejects bps > 10000 (over 100%)", () => {
      expect(() => computeApplicationFee(10000, 10001)).toThrow();
    });
  });

  describe("buildCheckoutSessionParams", () => {
    it("builds line_items from order lines + application_fee_amount", () => {
      const order = {
        id: "order-1",
        totalCents: 5498,
        lines: [
          { variantId: "v1", productTitle: "T-Shirt", quantity: 2, unitPriceCents: 1999 },
          { variantId: "v2", productTitle: "Mug", quantity: 3, unitPriceCents: 500 },
        ],
      };
      const params = buildCheckoutSessionParams({
        storeId: "store-1",
        order,
        commissionBps: 250,
        connectAccountId: "acct_connect123",
        successUrl: "https://store.shp0.dev/order/order-1",
        cancelUrl: "https://store.shp0.dev/checkout",
      });

      // Two line items, one per variant.
      expect(params.line_items).toHaveLength(2);
      expect(params.line_items[0]).toEqual({
        quantity: 2,
        price_data: {
          currency: "usd",
          unit_amount: 1999,
          product_data: { name: "T-Shirt" },
        },
      });

      // Application fee = 5498 * 2.5% = 137.45 → floor 137
      expect(params.application_fee_amount).toBe(137);
      expect(params.payment_intent_data).toEqual({
        application_fee_amount: 137,
        transfer_data: { destination: "acct_connect123" },
        metadata: { shp0_store_id: "store-1", shp0_order_id: "order-1" },
      });
      expect(params.mode).toBe("payment");
      expect(params.success_url).toBe("https://store.shp0.dev/order/order-1");
      expect(params.cancel_url).toBe("https://store.shp0.dev/checkout");
    });

    it("names the Store and the Order in the session's and the PaymentIntent's metadata (ADR-0006)", () => {
      const order = {
        id: "order-abc",
        totalCents: 1000,
        lines: [{ variantId: "v1", productTitle: "Item", quantity: 1, unitPriceCents: 1000 }],
      };
      const params = buildCheckoutSessionParams({
        storeId: "store-abc",
        order,
        commissionBps: 0,
        connectAccountId: "acct_1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });
      const metadata = { shp0_store_id: "store-abc", shp0_order_id: "order-abc" };
      expect(params.metadata).toEqual(metadata);
      expect(params.payment_intent_data.metadata).toEqual(metadata);
    });
  });
});

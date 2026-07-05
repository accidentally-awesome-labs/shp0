import { describe, it, expect } from "vitest";

import {
  transitionPayment,
  transitionFulfillment,
  isOrderOpen,
  type PaymentStatus,
  type FulfillmentStatus,
} from "../src/order";

/**
 * Issue #9 — Order lifecycle as two independent state machines.
 * ADR-0005 (glossary): payment and fulfillment are independent axes.
 * The overall Order state (open vs closed) is derived from both.
 *
 * Payment axis:    pending → {paid, voided, cancelled}
 * Fulfillment axis: unfulfilled → {fulfilled}
 */
describe("Order state machines (Issue #9)", () => {
  describe("transitionPayment", () => {
    it("allows pending → paid", () => {
      expect(transitionPayment("pending", "paid")).toBe("paid");
    });

    it("allows pending → voided", () => {
      expect(transitionPayment("pending", "voided")).toBe("voided");
    });

    it("allows pending → cancelled", () => {
      expect(transitionPayment("pending", "cancelled")).toBe("cancelled");
    });

    it("allows pending → refunded (refund after paid handled later)", () => {
      expect(transitionPayment("paid", "refunded")).toBe("refunded");
    });

    it("rejects terminal → anything (paid is terminal)", () => {
      expect(() => transitionPayment("paid", "pending")).toThrow();
      expect(() => transitionPayment("paid", "voided")).toThrow();
    });

    it("rejects voided → anything (voided is terminal)", () => {
      expect(() => transitionPayment("voided", "paid")).toThrow();
    });

    it("rejects cancelled → anything (cancelled is terminal)", () => {
      expect(() => transitionPayment("cancelled", "paid")).toThrow();
    });

    it("rejects unknown payment states", () => {
      expect(() => transitionPayment("pending", "unknown" as PaymentStatus)).toThrow();
    });
  });

  describe("transitionFulfillment", () => {
    it("allows unfulfilled → fulfilled", () => {
      expect(transitionFulfillment("unfulfilled", "fulfilled")).toBe("fulfilled");
    });

    it("rejects fulfilled → unfulfilled (fulfilled is terminal)", () => {
      expect(() => transitionFulfillment("fulfilled", "unfulfilled")).toThrow();
    });

    it("rejects fulfilled → fulfilled (no-op on terminal)", () => {
      expect(() => transitionFulfillment("fulfilled", "fulfilled")).toThrow();
    });

    it("rejects unknown fulfillment states", () => {
      expect(() =>
        transitionFulfillment("unfulfilled", "unknown" as FulfillmentStatus),
      ).toThrow();
    });
  });

  describe("isOrderOpen (derived state)", () => {
    it("is open when both axes are at their start (pending/unfulfilled)", () => {
      expect(isOrderOpen({ payment: "pending", fulfillment: "unfulfilled" })).toBe(true);
    });

    it("is open when payment is terminal but fulfillment is not (paid/unfulfilled)", () => {
      expect(isOrderOpen({ payment: "paid", fulfillment: "unfulfilled" })).toBe(true);
    });

    it("is open when fulfillment is terminal but payment is not (pending/fulfilled)", () => {
      expect(isOrderOpen({ payment: "pending", fulfillment: "fulfilled" })).toBe(true);
    });

    it("is closed when both axes are terminal (paid/fulfilled)", () => {
      expect(isOrderOpen({ payment: "paid", fulfillment: "fulfilled" })).toBe(false);
    });

    it("is closed when both axes are terminal (voided/fulfilled)", () => {
      expect(isOrderOpen({ payment: "voided", fulfillment: "fulfilled" })).toBe(false);
    });
  });
});

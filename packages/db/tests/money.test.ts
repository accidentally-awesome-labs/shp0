import { describe, it, expect } from "vitest";

import { parseMoney, formatMoney, applyPercent } from "../src/money";

/**
 * ADR-0004 — Money as integer minor units, never floats.
 * These are the platform's most safety-critical helpers: every price, total,
 * and fee flows through them. If these are wrong, charges are wrong.
 */
describe("Money helper (ADR-0004)", () => {
  describe("parseMoney", () => {
    it("parses a decimal string into integer minor units", () => {
      expect(parseMoney("19.99", "USD")).toBe(1999);
      expect(parseMoney("0.01", "USD")).toBe(1);
      expect(parseMoney("100", "USD")).toBe(10000);
      expect(parseMoney("100.00", "USD")).toBe(10000);
    });

    it("handles a leading $ sign gracefully", () => {
      expect(parseMoney("$19.99", "USD")).toBe(1999);
    });

    it("rejects negative amounts", () => {
      expect(() => parseMoney("-5.00", "USD")).toThrow();
    });

    it("supports 0-decimal currencies (JPY)", () => {
      expect(parseMoney("1000", "JPY")).toBe(1000);
    });
  });

  describe("formatMoney", () => {
    it("formats minor units into a display string with a symbol", () => {
      expect(formatMoney(1999, "USD")).toBe("$19.99");
      expect(formatMoney(100, "USD")).toBe("$1.00");
      expect(formatMoney(1, "USD")).toBe("$0.01");
    });

    it("formats 0-decimal currencies without decimals (JPY)", () => {
      expect(formatMoney(1000, "JPY")).toBe("¥1000");
    });
  });

  describe("applyPercent", () => {
    it("applies a percentage (in basis points) with round-half-up", () => {
      // 10% of $19.99 = $2.00 (199.9 → round half-up → 200)
      expect(applyPercent(1999, 1000)).toBe(200);
      // 15% of $10.00 = $1.50 (exactly)
      expect(applyPercent(1000, 1500)).toBe(150);
      // 50% of $10.00 = $5.00
      expect(applyPercent(1000, 5000)).toBe(500);
    });

    it("rounds half-up at the boundary", () => {
      // 10% of $10.05 = $1.005 → round half-up → $1.01 (101)
      expect(applyPercent(1005, 1000)).toBe(101);
    });

    it("never returns negative", () => {
      expect(applyPercent(0, 1000)).toBe(0);
    });
  });
});

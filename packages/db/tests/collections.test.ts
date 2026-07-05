import { describe, it, expect } from "vitest";

import { matchesRule } from "../src/collections";

/**
 * Issue #11 — Collection rule evaluator (pure function).
 *
 * The deep module: decides whether a product matches a collection's rule.
 * Pure — no I/O. The DB layer translates rules into SQL filters; this function
 * is the single source of truth for what "matches" means.
 *
 * Product shape for evaluation carries tags + minPriceCents (the product's
 * cheapest variant price).
 */
describe("Collection rule evaluator (Issue #11)", () => {
  describe("tag rule", () => {
    it("matches a product that has the rule's tag", () => {
      const rule = { type: "tag" as const, tag: "summer" };
      const product = { tags: ["summer", "sale"], minPriceCents: 1000 };
      expect(matchesRule(rule, product)).toBe(true);
    });

    it("does NOT match a product missing the tag", () => {
      const rule = { type: "tag" as const, tag: "summer" };
      const product = { tags: ["winter", "sale"], minPriceCents: 1000 };
      expect(matchesRule(rule, product)).toBe(false);
    });

    it("does NOT match a product with no tags", () => {
      const rule = { type: "tag" as const, tag: "summer" };
      const product = { tags: [], minPriceCents: 1000 };
      expect(matchesRule(rule, product)).toBe(false);
    });
  });

  describe("price_range rule", () => {
    it("matches a product within an inclusive range", () => {
      const rule = { type: "price_range" as const, minCents: 1000, maxCents: 5000 };
      expect(matchesRule(rule, { tags: [], minPriceCents: 2500 })).toBe(true);
    });

    it("matches at the min boundary (inclusive)", () => {
      const rule = { type: "price_range" as const, minCents: 1000, maxCents: 5000 };
      expect(matchesRule(rule, { tags: [], minPriceCents: 1000 })).toBe(true);
    });

    it("matches at the max boundary (inclusive)", () => {
      const rule = { type: "price_range" as const, minCents: 1000, maxCents: 5000 };
      expect(matchesRule(rule, { tags: [], minPriceCents: 5000 })).toBe(true);
    });

    it("does NOT match below the range", () => {
      const rule = { type: "price_range" as const, minCents: 1000, maxCents: 5000 };
      expect(matchesRule(rule, { tags: [], minPriceCents: 999 })).toBe(false);
    });

    it("does NOT match above the range", () => {
      const rule = { type: "price_range" as const, minCents: 1000, maxCents: 5000 };
      expect(matchesRule(rule, { tags: [], minPriceCents: 5001 })).toBe(false);
    });

    it("matches with only a minCents (no upper bound)", () => {
      const rule = { type: "price_range" as const, minCents: 1000 };
      expect(matchesRule(rule, { tags: [], minPriceCents: 9999 })).toBe(true);
      expect(matchesRule(rule, { tags: [], minPriceCents: 500 })).toBe(false);
    });

    it("matches with only a maxCents (no lower bound)", () => {
      const rule = { type: "price_range" as const, maxCents: 5000 };
      expect(matchesRule(rule, { tags: [], minPriceCents: 100 })).toBe(true);
      expect(matchesRule(rule, { tags: [], minPriceCents: 5001 })).toBe(false);
    });
  });
});

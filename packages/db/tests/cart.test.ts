import { describe, it, expect } from "vitest";

import {
  addLine,
  updateLine,
  removeLine,
  computeSubtotal,
  mergeCarts,
  type Cart,
} from "../src/cart";

/**
 * Issue #8 — Cart line math + merge.
 * These are pure functions — no DB, no I/O. They are the core of the cart
 * domain logic and the highest-value tests.
 *
 * Per ADR-0002: a Cart holds no money and reserves no inventory. The line math
 * only tracks variantId + quantity. Prices are computed at read time from
 * the live Variant price, not stored in the Cart.
 */
describe("Cart line math (Issue #8)", () => {
  describe("addLine", () => {
    it("adds a new line to an empty cart", () => {
      const cart: Cart = { storeId: "s1", lines: [] };
      const result = addLine(cart, { variantId: "v1", quantity: 2 });
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toEqual({ variantId: "v1", quantity: 2 });
    });

    it("increments quantity when adding to an existing line", () => {
      const cart: Cart = {
        storeId: "s1",
        lines: [{ variantId: "v1", quantity: 2 }],
      };
      const result = addLine(cart, { variantId: "v1", quantity: 3 });
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]!.quantity).toBe(5);
    });

    it("rejects zero or negative quantity", () => {
      const cart: Cart = { storeId: "s1", lines: [] };
      expect(() => addLine(cart, { variantId: "v1", quantity: 0 })).toThrow();
      expect(() => addLine(cart, { variantId: "v1", quantity: -1 })).toThrow();
    });

    it("returns a new cart (immutable — does not mutate input)", () => {
      const cart: Cart = { storeId: "s1", lines: [] };
      const result = addLine(cart, { variantId: "v1", quantity: 1 });
      expect(cart.lines).toHaveLength(0); // original unchanged
      expect(result.lines).toHaveLength(1);
    });
  });

  describe("updateLine", () => {
    it("updates the quantity of an existing line", () => {
      const cart: Cart = {
        storeId: "s1",
        lines: [{ variantId: "v1", quantity: 2 }],
      };
      const result = updateLine(cart, { variantId: "v1", quantity: 5 });
      expect(result.lines[0]!.quantity).toBe(5);
    });

    it("removes the line when quantity is set to 0", () => {
      const cart: Cart = {
        storeId: "s1",
        lines: [
          { variantId: "v1", quantity: 2 },
          { variantId: "v2", quantity: 1 },
        ],
      };
      const result = updateLine(cart, { variantId: "v1", quantity: 0 });
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]!.variantId).toBe("v2");
    });

    it("rejects negative quantity", () => {
      const cart: Cart = {
        storeId: "s1",
        lines: [{ variantId: "v1", quantity: 2 }],
      };
      expect(() => updateLine(cart, { variantId: "v1", quantity: -1 })).toThrow();
    });
  });

  describe("removeLine", () => {
    it("removes a line by variantId", () => {
      const cart: Cart = {
        storeId: "s1",
        lines: [
          { variantId: "v1", quantity: 2 },
          { variantId: "v2", quantity: 1 },
        ],
      };
      const result = removeLine(cart, "v1");
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]!.variantId).toBe("v2");
    });

    it("is a no-op if the variantId is not in the cart", () => {
      const cart: Cart = { storeId: "s1", lines: [{ variantId: "v1", quantity: 1 }] };
      const result = removeLine(cart, "nonexistent");
      expect(result.lines).toHaveLength(1);
    });
  });

  describe("computeSubtotal", () => {
    it("sums quantity * price for each line", () => {
      const cart: Cart = {
        storeId: "s1",
        lines: [
          { variantId: "v1", quantity: 2 },
          { variantId: "v2", quantity: 3 },
        ],
      };
      const prices = new Map([
        ["v1", 1999], // $19.99
        ["v2", 500],  // $5.00
      ]);
      // 2*1999 + 3*500 = 3998 + 1500 = 5498
      expect(computeSubtotal(cart, prices)).toBe(5498);
    });

    it("treats unknown variants as price 0 (deleted/removed)", () => {
      const cart: Cart = {
        storeId: "s1",
        lines: [{ variantId: "v1", quantity: 2 }],
      };
      const prices = new Map(); // v1 not in the map
      expect(computeSubtotal(cart, prices)).toBe(0);
    });
  });

  describe("mergeCarts (merge-on-login)", () => {
    it("combines two carts, summing quantities for the same variant", () => {
      const anon: Cart = {
        storeId: "s1",
        lines: [
          { variantId: "v1", quantity: 2 },
          { variantId: "v2", quantity: 1 },
        ],
      };
      const db: Cart = {
        storeId: "s1",
        lines: [
          { variantId: "v1", quantity: 3 },
          { variantId: "v3", quantity: 1 },
        ],
      };
      const merged = mergeCarts(anon, db);
      // v1: 2+3=5, v2: 1 (from anon), v3: 1 (from db)
      const byVariant = new Map(merged.lines.map((l) => [l.variantId, l.quantity]));
      expect(byVariant.get("v1")).toBe(5);
      expect(byVariant.get("v2")).toBe(1);
      expect(byVariant.get("v3")).toBe(1);
      expect(merged.lines).toHaveLength(3);
    });

    it("produces an empty cart from two empty carts", () => {
      const empty: Cart = { storeId: "s1", lines: [] };
      const merged = mergeCarts(empty, empty);
      expect(merged.lines).toHaveLength(0);
    });

    it("requires both carts to be the same store", () => {
      const a: Cart = { storeId: "s1", lines: [] };
      const b: Cart = { storeId: "s2", lines: [] };
      expect(() => mergeCarts(a, b)).toThrow();
    });
  });
});

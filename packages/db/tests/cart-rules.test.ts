import { describe, it, expect } from "vitest";

import {
  MAX_LINE_QUANTITY,
  isValidLineQuantity,
  parseCartChange,
  applyCartChange,
  priceCartForCheckout,
  cartChangeRejectionMessage,
  checkoutRejectionMessage,
  CheckoutError,
  type Cart,
  type CartChangeRejection,
  type CheckoutRejection,
} from "../src/cart";
import { isUuid } from "../src/ids";

/**
 * The rules a storefront Cart line must satisfy, as pure functions. Server
 * actions receive untrusted input (any JSON value, from any client), so the
 * cart actions parse it with these before touching the database, and
 * checkout re-checks every line against the live catalog.
 */

const V1 = "0b8f6a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const V2 = "1c9e7b2f-4d5e-4f6a-9b0c-1d2e3f4a5b6c";
const V3 = "2d0f8c3a-5e6f-4a7b-8c1d-2e3f4a5b6c7d";

describe("isUuid", () => {
  it("accepts a UUID in either case", () => {
    expect(isUuid(V1)).toBe(true);
    expect(isUuid(V1.toUpperCase())).toBe(true);
  });

  it.each([
    ["not-a-uuid"],
    [""],
    [`${V1} `],
    [`${V1}x`],
    [V1.replace(/-/g, "")],
    ["'; DROP TABLE carts; --"],
    [42],
    [null],
    [undefined],
    [{}],
    [[V1]],
  ])("rejects %j", (value) => {
    expect(isUuid(value)).toBe(false);
  });
});

describe("Cart line quantity rule", () => {
  it(`is a whole number from 1 to ${MAX_LINE_QUANTITY}`, () => {
    expect(MAX_LINE_QUANTITY).toBe(99);
    for (const q of [1, 2, 50, 98, 99]) expect(isValidLineQuantity(q)).toBe(true);
  });

  it.each([
    [0],
    [-1],
    [1.5],
    [0.5],
    [100],
    [1e9],
    [Number.MAX_SAFE_INTEGER],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    ["2"],
    ["1"],
    [null],
    [undefined],
    [true],
    [{}],
    [[1]],
  ])("rejects %j", (q) => {
    expect(isValidLineQuantity(q)).toBe(false);
  });
});

describe("parseCartChange (untrusted server-action input)", () => {
  it("parses a valid add, set and remove", () => {
    expect(parseCartChange("add", V1, 2)).toEqual({ ok: true, change: { kind: "add", variantId: V1, quantity: 2 } });
    expect(parseCartChange("set", V1, 5)).toEqual({ ok: true, change: { kind: "set", variantId: V1, quantity: 5 } });
    expect(parseCartChange("remove", V1)).toEqual({ ok: true, change: { kind: "remove", variantId: V1 } });
  });

  it("normalizes the Variant id to lowercase (Postgres returns lowercase ids)", () => {
    expect(parseCartChange("add", V1.toUpperCase(), 1)).toEqual({
      ok: true,
      change: { kind: "add", variantId: V1, quantity: 1 },
    });
  });

  it("set with quantity 0 is allowed: it removes the line, like updateLine", () => {
    expect(parseCartChange("set", V1, 0)).toEqual({ ok: true, change: { kind: "set", variantId: V1, quantity: 0 } });
  });

  it.each([["not-a-uuid"], [""], [42], [null], [undefined], [{ id: V1 }]])(
    "refuses Variant id %j as unavailable, for every kind",
    (variantId) => {
      expect(parseCartChange("add", variantId, 1)).toEqual({ ok: false, reason: "unavailable" });
      expect(parseCartChange("set", variantId, 1)).toEqual({ ok: false, reason: "unavailable" });
      expect(parseCartChange("remove", variantId)).toEqual({ ok: false, reason: "unavailable" });
    },
  );

  it.each([[-1], [0], [1.5], [1e9], [100], ["2"], [null], [undefined], [Number.NaN]])(
    "refuses add quantity %j",
    (quantity) => {
      expect(parseCartChange("add", V1, quantity)).toEqual({ ok: false, reason: "invalid_quantity" });
    },
  );

  it.each([[-1], [2.5], [1e9], [100], ["3"], [null], [undefined]])("refuses set quantity %j", (quantity) => {
    expect(parseCartChange("set", V1, quantity)).toEqual({ ok: false, reason: "invalid_quantity" });
  });
});

describe("applyCartChange", () => {
  const cart: Cart = {
    storeId: "s1",
    lines: [
      { variantId: V1, quantity: 2 },
      { variantId: V2, quantity: 97 },
    ],
  };

  it("add sums with an existing line (addLine) and appends a new one", () => {
    expect(applyCartChange(cart, { kind: "add", variantId: V1, quantity: 3 })).toEqual({
      ok: true,
      cart: { storeId: "s1", lines: [{ variantId: V1, quantity: 5 }, { variantId: V2, quantity: 97 }] },
    });
    expect(applyCartChange(cart, { kind: "add", variantId: V3, quantity: 1 })).toEqual({
      ok: true,
      cart: { storeId: "s1", lines: [...cart.lines, { variantId: V3, quantity: 1 }] },
    });
  });

  it(`add refuses to take a line above ${MAX_LINE_QUANTITY}, and changes nothing`, () => {
    expect(applyCartChange(cart, { kind: "add", variantId: V2, quantity: 2 })).toEqual({ ok: true, cart: expect.anything() });
    expect(applyCartChange(cart, { kind: "add", variantId: V2, quantity: 3 })).toEqual({ ok: false, reason: "quantity_limit" });
    expect(cart.lines[1]).toEqual({ variantId: V2, quantity: 97 });
  });

  it("add re-checks the quantity rule itself", () => {
    for (const quantity of [0, -1, 1.5, 1e9]) {
      expect(applyCartChange(cart, { kind: "add", variantId: V3, quantity })).toEqual({
        ok: false,
        reason: "invalid_quantity",
      });
    }
  });

  it("set replaces a quantity; 0 removes the line; a Variant not in the Cart is a no-op (updateLine)", () => {
    expect(applyCartChange(cart, { kind: "set", variantId: V2, quantity: 99 })).toEqual({
      ok: true,
      cart: { storeId: "s1", lines: [{ variantId: V1, quantity: 2 }, { variantId: V2, quantity: 99 }] },
    });
    expect(applyCartChange(cart, { kind: "set", variantId: V1, quantity: 0 })).toEqual({
      ok: true,
      cart: { storeId: "s1", lines: [{ variantId: V2, quantity: 97 }] },
    });
    expect(applyCartChange(cart, { kind: "set", variantId: V3, quantity: 4 })).toEqual({ ok: true, cart });
  });

  it("set re-checks the quantity rule itself", () => {
    for (const quantity of [-1, 100, 2.5]) {
      expect(applyCartChange(cart, { kind: "set", variantId: V1, quantity })).toEqual({
        ok: false,
        reason: "invalid_quantity",
      });
    }
  });

  it("remove drops the line (removeLine)", () => {
    expect(applyCartChange(cart, { kind: "remove", variantId: V1 })).toEqual({
      ok: true,
      cart: { storeId: "s1", lines: [{ variantId: V2, quantity: 97 }] },
    });
  });
});

describe("priceCartForCheckout (checkout re-validates every line)", () => {
  const catalog = new Map([
    [V1, { priceCents: 1000, published: true }],
    [V2, { priceCents: 250, published: true }],
    [V3, { priceCents: 1, published: false }],
  ]);

  it("prices valid lines from the live catalog with integer math", () => {
    expect(
      priceCartForCheckout(
        [
          { variantId: V1, quantity: 2 },
          { variantId: V2, quantity: 3 },
        ],
        catalog,
      ),
    ).toEqual({
      ok: true,
      lines: [
        { variantId: V1, quantity: 2, unitPriceCents: 1000 },
        { variantId: V2, quantity: 3, unitPriceCents: 250 },
      ],
      totalCents: 2750,
    });
  });

  it("refuses an empty Cart", () => {
    expect(priceCartForCheckout([], catalog)).toEqual({ ok: false, reason: "empty_cart" });
  });

  it("refuses the WHOLE Cart when any line is invalid, and names every invalid line", () => {
    const unknown = "3e1a9d4b-6f7a-4b8c-9d2e-3f4a5b6c7d8e";
    expect(
      priceCartForCheckout(
        [
          { variantId: V1, quantity: 1 },
          { variantId: V3, quantity: 1 }, // draft Product
          { variantId: unknown, quantity: 1 }, // not a Variant this Store can see
          { variantId: V2, quantity: 0 },
          { variantId: V2, quantity: -1 },
          { variantId: V1, quantity: 100 },
          { variantId: V1, quantity: 1.5 },
        ],
        catalog,
      ),
    ).toEqual({
      ok: false,
      reason: "invalid_lines",
      problems: [
        { variantId: V3, reason: "unavailable" },
        { variantId: unknown, reason: "unavailable" },
        { variantId: V2, reason: "invalid_quantity" },
        { variantId: V2, reason: "invalid_quantity" },
        { variantId: V1, reason: "invalid_quantity" },
        { variantId: V1, reason: "invalid_quantity" },
      ],
    });
  });

  it("treats a Variant with a price that is not a safe integer of minor units as unavailable", () => {
    const odd = new Map([
      [V1, { priceCents: 10.5, published: true }],
      [V2, { priceCents: -1, published: true }],
    ]);
    expect(
      priceCartForCheckout(
        [
          { variantId: V1, quantity: 1 },
          { variantId: V2, quantity: 1 },
        ],
        odd,
      ),
    ).toEqual({
      ok: false,
      reason: "invalid_lines",
      problems: [
        { variantId: V1, reason: "unavailable" },
        { variantId: V2, reason: "unavailable" },
      ],
    });
  });
});

describe("shopper-facing messages", () => {
  it("has a message for every Cart change rejection", () => {
    const reasons: CartChangeRejection[] = ["unavailable", "invalid_quantity", "quantity_limit"];
    for (const reason of reasons) expect(cartChangeRejectionMessage(reason)).toMatch(/\w/);
    expect(cartChangeRejectionMessage("invalid_quantity")).toContain(String(MAX_LINE_QUANTITY));
    expect(cartChangeRejectionMessage("quantity_limit")).toContain(String(MAX_LINE_QUANTITY));
  });

  it("has a message for every checkout rejection, carried by CheckoutError", () => {
    const reasons: CheckoutRejection[] = ["empty_cart", "invalid_lines"];
    for (const reason of reasons) {
      const error = new CheckoutError(reason);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("CheckoutError");
      expect(error.reason).toBe(reason);
      expect(error.message).toBe(checkoutRejectionMessage(reason));
      expect(error.problems).toEqual([]);
    }
    const problems = [{ variantId: V3, reason: "unavailable" as const }];
    expect(new CheckoutError("invalid_lines", problems).problems).toEqual(problems);
  });
});

import { describe, it, expect } from "vitest";

import {
  OPERATOR_USER_IDS_ENV,
  parseOperatorUserIds,
  isOperator,
  decideOperatorAccess,
  assertOperator,
} from "../src/operator";

/**
 * Issue #52 — Operator (platform admin) authorization policy.
 *
 * Operators are an allowlist of better-auth user ids read from
 * SHP0_OPERATOR_USER_IDS (ids, never emails, as proposed in decision #73). The
 * policy fails closed: with the variable unset or empty, nobody is an Operator.
 *
 * Pure: no database, no network, no environment reads.
 */
describe("Operator allowlist policy (Issue #52)", () => {
  it("reads its allowlist from SHP0_OPERATOR_USER_IDS", () => {
    expect(OPERATOR_USER_IDS_ENV).toBe("SHP0_OPERATOR_USER_IDS");
  });

  describe("fails closed", () => {
    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["whitespace only", "   "],
      ["separators only", ","],
      ["separators and whitespace only", " , ,, \t,\n"],
    ])("nobody is an Operator when the variable is %s", (_label, raw) => {
      const operators = parseOperatorUserIds(raw);
      expect(operators.size).toBe(0);
      expect(isOperator("user_1", operators)).toBe(false);
      expect(isOperator("", operators)).toBe(false);
    });

    it("a signed-in user who is not listed is not an Operator", () => {
      const operators = parseOperatorUserIds("op_1,op_2");
      expect(isOperator("merchant_1", operators)).toBe(false);
    });

    it("a missing or empty user id is never an Operator", () => {
      const operators = parseOperatorUserIds("op_1");
      expect(isOperator(undefined, operators)).toBe(false);
      expect(isOperator(null, operators)).toBe(false);
      expect(isOperator("", operators)).toBe(false);
    });

    it("has no wildcard: '*' grants nobody", () => {
      const operators = parseOperatorUserIds("*");
      expect(isOperator("merchant_1", operators)).toBe(false);
      expect(isOperator("op_1", operators)).toBe(false);
    });
  });

  describe("parsing", () => {
    it("splits on commas, trims whitespace and ignores empty entries", () => {
      const operators = parseOperatorUserIds(" op_1 , ,op_2,,\top_3\n, ");
      expect([...operators].sort()).toEqual(["op_1", "op_2", "op_3"]);
    });

    it("keeps a single id", () => {
      expect([...parseOperatorUserIds("op_1")]).toEqual(["op_1"]);
    });

    it("collapses duplicate ids", () => {
      expect([...parseOperatorUserIds("op_1,op_1, op_1")]).toEqual(["op_1"]);
    });
  });

  describe("matching", () => {
    it("a listed user id is an Operator", () => {
      const operators = parseOperatorUserIds("op_1, op_2");
      expect(isOperator("op_1", operators)).toBe(true);
      expect(isOperator("op_2", operators)).toBe(true);
    });

    it("matches whole ids exactly: no prefix, substring or case-insensitive match", () => {
      const operators = parseOperatorUserIds("AbC123");
      expect(isOperator("AbC123", operators)).toBe(true);
      expect(isOperator("abc123", operators)).toBe(false);
      expect(isOperator("AbC12", operators)).toBe(false);
      expect(isOperator("AbC1234", operators)).toBe(false);
      expect(isOperator(" AbC123", operators)).toBe(false);
    });

    it("the whole raw value is not itself an id", () => {
      const operators = parseOperatorUserIds("op_1,op_2");
      expect(isOperator("op_1,op_2", operators)).toBe(false);
    });
  });

  // What the web app's requireOperator() and the /admin gate decide for one
  // request: the signed-in user's id (or none) against the raw variable.
  describe("request access", () => {
    it.each([
      ["no session", null],
      ["no session (undefined)", undefined],
    ])("%s is unauthenticated, whatever the allowlist says", (_label, sessionUserId) => {
      expect(decideOperatorAccess(sessionUserId, "op_1")).toEqual({ status: "unauthenticated" });
      expect(decideOperatorAccess(sessionUserId, undefined)).toEqual({ status: "unauthenticated" });
    });

    it("a signed-in user who is not listed is forbidden", () => {
      expect(decideOperatorAccess("merchant_1", "op_1, op_2")).toEqual({ status: "forbidden" });
    });

    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["separators only", " , ,"],
      ["a wildcard", "*"],
    ])("a signed-in user is forbidden when the variable is %s (fails closed)", (_label, raw) => {
      expect(decideOperatorAccess("op_1", raw)).toEqual({ status: "forbidden" });
    });

    it("a listed user is an Operator", () => {
      expect(decideOperatorAccess("op_2", " , op_1 ,op_2,")).toEqual({
        status: "operator",
        userId: "op_2",
      });
    });

    it("an empty user id on a session is forbidden, not an Operator", () => {
      expect(decideOperatorAccess("", "op_1")).toEqual({ status: "forbidden" });
    });
  });

  describe("assertOperator", () => {
    it("throws 'Not authenticated' without a session", () => {
      expect(() => assertOperator({ status: "unauthenticated" })).toThrowError(
        /^Not authenticated$/,
      );
    });

    it("throws a generic 'Not authorized' for a signed-in non-Operator", () => {
      expect(() => assertOperator({ status: "forbidden" })).toThrowError(/^Not authorized$/);
    });

    it("returns the Operator's user id", () => {
      expect(assertOperator({ status: "operator", userId: "op_1" })).toEqual({ userId: "op_1" });
    });

    it("rejects a signed-in Merchant end to end, and lets a listed Operator through", () => {
      expect(() => assertOperator(decideOperatorAccess("merchant_1", "op_1"))).toThrowError(
        /^Not authorized$/,
      );
      expect(() => assertOperator(decideOperatorAccess(null, "op_1"))).toThrowError(
        /^Not authenticated$/,
      );
      expect(assertOperator(decideOperatorAccess("op_1", "op_1"))).toEqual({ userId: "op_1" });
    });
  });
});

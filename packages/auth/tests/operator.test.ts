import { describe, it, expect } from "vitest";

import {
  OPERATOR_USER_IDS_ENV,
  parseOperatorUserIds,
  isOperator,
} from "../src/operator";

/**
 * Issue #52 — Operator (platform admin) authorization policy.
 *
 * Operators are an allowlist of better-auth user ids read from
 * SHP0_OPERATOR_USER_IDS (decision #73: ids, never emails). The policy fails
 * closed: with the variable unset or empty, nobody is an Operator.
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
});

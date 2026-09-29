import { describe, it, expect } from "vitest";

import {
  customerFormMessage,
  CustomerSignUpError,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  parseCustomerSignIn,
  parseCustomerSignUp,
} from "../src/index";

/**
 * The storefront's Customer sign-up and sign-in forms (ADR-0003): untrusted
 * input is parsed before any query, and each refusal has a message the
 * Customer can act on. Sign-in never says which of the email or the
 * password was wrong.
 */

const good = { email: "shopper@example.com", name: "Test Shopper", password: "password123" };

describe("parseCustomerSignUp", () => {
  it("accepts a name, an email and a password, trimming the name and email", () => {
    expect(parseCustomerSignUp({ email: "  shopper@example.com ", name: "  Test Shopper ", password: "password123" })).toEqual({
      ok: true,
      value: good,
    });
  });

  it("keeps the password exactly as typed", () => {
    expect(parseCustomerSignUp({ ...good, password: " pass word " })).toMatchObject({ ok: true, value: { password: " pass word " } });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["no email", { ...good, email: "" }, "invalid_email"],
    ["an email with no domain", { ...good, email: "shopper@" }, "invalid_email"],
    ["an email with spaces", { ...good, email: "shop per@example.com" }, "invalid_email"],
    ["an email longer than 254 characters", { ...good, email: `${"a".repeat(250)}@example.com` }, "invalid_email"],
    ["an email that is not text (a file)", { ...good, email: new Blob(["x"]) }, "invalid_email"],
    ["no name", { ...good, name: "   " }, "missing_name"],
    ["a name that is not text", { ...good, name: null }, "missing_name"],
    ["a name longer than 100 characters", { ...good, name: "n".repeat(101) }, "name_too_long"],
    ["a short password", { ...good, password: "x".repeat(MIN_PASSWORD_LENGTH - 1) }, "weak_password"],
    ["a password that is not text", { ...good, password: undefined }, "weak_password"],
    ["a very long password", { ...good, password: "x".repeat(MAX_PASSWORD_LENGTH + 1) }, "password_too_long"],
  ])("refuses %s", (_name, input, reason) => {
    expect(parseCustomerSignUp(input)).toEqual({ ok: false, reason });
  });
});

describe("parseCustomerSignIn", () => {
  it("accepts an email and a password, trimming the email", () => {
    expect(parseCustomerSignIn({ email: " shopper@example.com ", password: "short" })).toEqual({
      ok: true,
      value: { email: "shopper@example.com", password: "short" },
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["no email", { email: "", password: "password123" }],
    ["no password", { email: "shopper@example.com", password: "" }],
    ["a password that is not text", { email: "shopper@example.com", password: new Blob(["x"]) }],
    ["a very long password", { email: "shopper@example.com", password: "x".repeat(MAX_PASSWORD_LENGTH + 1) }],
  ])("refuses %s as wrong credentials, without saying which", (_name, input) => {
    expect(parseCustomerSignIn(input)).toEqual({ ok: false, reason: "wrong_credentials" });
  });
});

describe("customerFormMessage", () => {
  it("says what to fix, and never which of the email or password was wrong", () => {
    expect(customerFormMessage("wrong_credentials")).toBe("The email or password is incorrect.");
    expect(customerFormMessage("email_taken")).toBe("An account with this email already exists in this store. Sign in instead.");
    expect(customerFormMessage("weak_password")).toBe(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
    for (const reason of ["invalid_email", "missing_name", "name_too_long", "password_too_long"] as const) {
      expect(customerFormMessage(reason)).toMatch(/\.$/);
    }
  });

  it("CustomerSignUpError carries its reason and message", () => {
    const error = new CustomerSignUpError("email_taken");
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe("email_taken");
    expect(error.message).toBe(customerFormMessage("email_taken"));
  });
});

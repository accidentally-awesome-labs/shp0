import { describe, it, expect } from "vitest";

import {
  CUSTOMER_SESSION_MAX_AGE_SECONDS,
  customerFormMessage,
  customerSessionCookieOptions,
  CustomerSignUpError,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  parseCustomerSignIn,
  parseCustomerSignUp,
  type CustomerFormRejection,
} from "../src/customer-forms";

/**
 * The storefront's Customer sign-up and sign-in forms (ADR-0003): untrusted
 * input is parsed before any query, and each refusal has a message the
 * Customer can act on. Sign-in never says which of the email or the
 * password was wrong.
 */

const good = { email: "shopper@example.com", name: "Test Shopper", password: "password123" };
const emailOfLength = (length: number) => `${"a".repeat(length - "@example.com".length)}@example.com`;

describe("the form rules", () => {
  it("are 8 to 200 characters for a password, 100 for a name, and 254 for an email", () => {
    expect([MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, MAX_NAME_LENGTH, MAX_EMAIL_LENGTH]).toEqual([8, 200, 100, 254]);
  });
});

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

  it.each<[string, Record<string, unknown>]>([
    ["a password of exactly 8 characters", { ...good, password: "x".repeat(8) }],
    ["a password of exactly 200 characters", { ...good, password: "x".repeat(200) }],
    ["a name of exactly 100 characters", { ...good, name: "n".repeat(100) }],
    ["an email of exactly 254 characters", { ...good, email: emailOfLength(254) }],
    ["an email padded with spaces past 254", { ...good, email: `  ${emailOfLength(254)}  ` }],
  ])("accepts %s", (_name, input) => {
    expect(parseCustomerSignUp(input)).toMatchObject({ ok: true });
  });

  it.each<[string, Record<string, unknown>, CustomerFormRejection]>([
    ["no email", { ...good, email: "" }, "invalid_email"],
    ["an email with no domain", { ...good, email: "shopper@" }, "invalid_email"],
    ["an email with no dot in the domain", { ...good, email: "shopper@example" }, "invalid_email"],
    ["an email with two @", { ...good, email: "a@b@example.com" }, "invalid_email"],
    ["an email with nothing before the @", { ...good, email: "@example.com" }, "invalid_email"],
    ["an email with spaces", { ...good, email: "shop per@example.com" }, "invalid_email"],
    ["an email with a NUL byte", { ...good, email: "shop\u0000per@example.com" }, "invalid_email"],
    ["an email with a control character", { ...good, email: "shop\u007fper@example.com" }, "invalid_email"],
    ["an email of 255 characters", { ...good, email: emailOfLength(255) }, "invalid_email"],
    ["an email that is a file, not text", { ...good, email: new Blob(["x"]) }, "invalid_email"],
    ["no name", { ...good, name: "   " }, "missing_name"],
    ["a missing name", { ...good, name: null }, "missing_name"],
    ["a name that is a file, not text", { ...good, name: new Blob(["Test Shopper"]) }, "missing_name"],
    ["a name with a NUL byte", { ...good, name: "Test\u0000Shopper" }, "invalid_name"],
    ["a name with a line break", { ...good, name: "Test\nShopper" }, "invalid_name"],
    ["a name of 101 characters", { ...good, name: "n".repeat(101) }, "name_too_long"],
    ["a password of 7 characters", { ...good, password: "x".repeat(7) }, "weak_password"],
    ["a missing password", { ...good, password: undefined }, "weak_password"],
    ["a password that is a file, not text", { ...good, password: new Blob(["password123"]) }, "weak_password"],
    ["a password of 201 characters", { ...good, password: "x".repeat(201) }, "password_too_long"],
  ])("refuses %s", (_name, input, reason) => {
    expect(parseCustomerSignUp(input)).toEqual({ ok: false, reason });
  });
});

describe("parseCustomerSignIn", () => {
  it("accepts an email and a password, trimming the email, with no minimum password length", () => {
    expect(parseCustomerSignIn({ email: " shopper@example.com ", password: "short" })).toEqual({
      ok: true,
      value: { email: "shopper@example.com", password: "short" },
    });
    expect(parseCustomerSignIn({ email: "shopper@example.com", password: "x".repeat(200) })).toMatchObject({ ok: true });
  });

  it.each<[string, Record<string, unknown>]>([
    ["no email", { email: "", password: "password123" }],
    ["an email with a NUL byte", { email: "shop\u0000per@example.com", password: "password123" }],
    ["an email of 255 characters", { email: emailOfLength(255), password: "password123" }],
    ["an email that is a file, not text", { email: new Blob(["shopper@example.com"]), password: "password123" }],
    ["no password", { email: "shopper@example.com", password: "" }],
    ["a password that is a file, not text", { email: "shopper@example.com", password: new Blob(["x"]) }],
    ["a password of 201 characters", { email: "shopper@example.com", password: "x".repeat(201) }],
  ])("refuses %s as wrong credentials, without saying which", (_name, input) => {
    expect(parseCustomerSignIn(input)).toEqual({ ok: false, reason: "wrong_credentials" });
  });
});

describe("customerFormMessage", () => {
  it("says what to fix, and never which of the email or password was wrong", () => {
    const messages: Record<CustomerFormRejection, string> = {
      invalid_email: "Enter a valid email address.",
      missing_name: "Enter your name.",
      invalid_name: "Enter a name without line breaks or control characters.",
      name_too_long: "Use a name of at most 100 characters.",
      weak_password: "Use a password of at least 8 characters.",
      password_too_long: "Use a password of at most 200 characters.",
      email_taken: "An account with this email already exists in this store. Sign in instead.",
      wrong_credentials: "The email or password is incorrect.",
    };
    for (const [reason, message] of Object.entries(messages)) {
      expect(customerFormMessage(reason as CustomerFormRejection), reason).toBe(message);
    }
  });

  it("CustomerSignUpError carries its reason, name and message", () => {
    const error = new CustomerSignUpError("email_taken");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "CustomerSignUpError", reason: "email_taken", message: customerFormMessage("email_taken") });
  });
});

describe("customerSessionCookieOptions", () => {
  it("is httpOnly, SameSite=Lax, for the whole host, for as long as the session lasts, and Secure in production", () => {
    expect(CUSTOMER_SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(customerSessionCookieOptions({ production: true })).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: CUSTOMER_SESSION_MAX_AGE_SECONDS,
    });
    // `next dev` serves http://, where a browser drops a Secure cookie on a storefront host.
    expect(customerSessionCookieOptions({ production: false })).toMatchObject({ secure: false, httpOnly: true });
  });
});

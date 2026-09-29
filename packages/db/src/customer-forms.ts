/**
 * The storefront's Customer sign-up and sign-in forms, and the Customer's
 * session cookie (ADR-0003): untrusted input is parsed here before any
 * query, and every refusal has a message the Customer can act on. Sign-in
 * refuses anything it cannot use as wrong credentials, so it never says
 * which of the email or password was wrong.
 */

export const MIN_PASSWORD_LENGTH = 8;
/** Longer passwords are refused before hashing: scrypt reads all of it. */
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_NAME_LENGTH = 100;
/** The longest address an email path can carry (RFC 5321). */
export const MAX_EMAIL_LENGTH = 254;

export type CustomerFormRejection =
  | "invalid_email"
  | "missing_name"
  | "invalid_name"
  | "name_too_long"
  | "weak_password"
  | "password_too_long"
  | "email_taken"
  | "wrong_credentials";

export type CustomerSignUp = { email: string; name: string; password: string };
export type CustomerSignIn = { email: string; password: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: CustomerFormRejection };

/** One @, something on each side, a dot in the domain, and no spaces. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Control characters (NUL included, which Postgres refuses in text). */
const CONTROL = /[\u0000-\u001f\u007f]/;

function parseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email) && !CONTROL.test(email) ? email : null;
}

/** A sign-up: an email, a name (both trimmed) and a password kept exactly as typed. */
export function parseCustomerSignUp(input: { email?: unknown; name?: unknown; password?: unknown }): Parsed<CustomerSignUp> {
  const email = parseEmail(input.email);
  if (email === null) return { ok: false, reason: "invalid_email" };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") return { ok: false, reason: "missing_name" };
  if (CONTROL.test(name)) return { ok: false, reason: "invalid_name" };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: "name_too_long" };
  const { password } = input;
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "weak_password" };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, reason: "password_too_long" };
  return { ok: true, value: { email, name, password } };
}

/**
 * A sign-in: an email (trimmed) and a password. No minimum length, so an
 * account made before the sign-up rules can still sign in.
 */
export function parseCustomerSignIn(input: { email?: unknown; password?: unknown }): Parsed<CustomerSignIn> {
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const { password } = input;
  if (
    email === "" ||
    email.length > MAX_EMAIL_LENGTH ||
    CONTROL.test(email) ||
    typeof password !== "string" ||
    password === "" ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return { ok: false, reason: "wrong_credentials" };
  }
  return { ok: true, value: { email, password } };
}

/** The Customer-facing message for a refused form. */
export function customerFormMessage(reason: CustomerFormRejection): string {
  switch (reason) {
    case "invalid_email":
      return "Enter a valid email address.";
    case "missing_name":
      return "Enter your name.";
    case "invalid_name":
      return "Enter a name without line breaks or control characters.";
    case "name_too_long":
      return `Use a name of at most ${MAX_NAME_LENGTH} characters.`;
    case "weak_password":
      return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
    case "password_too_long":
      return `Use a password of at most ${MAX_PASSWORD_LENGTH} characters.`;
    case "email_taken":
      return "An account with this email already exists in this store. Sign in instead.";
    case "wrong_credentials":
      return "The email or password is incorrect.";
  }
}

/** Thrown by signUpCustomer when the Store already has a Customer with that email; nothing was written. */
export class CustomerSignUpError extends Error {
  readonly reason: "email_taken";

  constructor(reason: "email_taken") {
    super(customerFormMessage(reason));
    this.name = "CustomerSignUpError";
    this.reason = reason;
  }
}

/** How long a Customer's session lasts: 30 days (the session row and its cookie). */
export const CUSTOMER_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The Customer's session cookie: a bearer token for their account in one
 * Store, httpOnly, SameSite=Lax and host-only (no domain), like the cart
 * token. Secure in production builds; `next dev` serves http://, where a
 * browser drops a Secure cookie on a storefront host.
 */
export function customerSessionCookieOptions({ production }: { production: boolean }) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax" as const,
    path: "/",
    maxAge: CUSTOMER_SESSION_MAX_AGE_SECONDS,
  };
}

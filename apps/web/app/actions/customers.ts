"use server";

import { cookies } from "next/headers";

import { authorizeStore, resolveStorefrontStore } from "@/lib/current-store";
import {
  customerFormMessage,
  customerSessionCookieOptions,
  getCustomerBySession,
  isUuid,
  listCustomers,
  listCustomerOrders,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  signOutCustomer,
  startCustomerSignIn,
  startCustomerSignUp,
  type CustomerSessionResult,
} from "@shp0/db";

/** The Customer's session cookie (ADR-0003; customerSessionCookieOptions). */
const SESSION_COOKIE = "customer_session";

/**
 * What a Customer form does next: the account page, or why not, with what
 * the Customer typed (never the password) to fill the form again. Returned,
 * not thrown (a thrown error's message is a digest in production), and not
 * a redirect(): Next renders a server action's same-site redirect target
 * through an internal request without the storefront's Host, which finds no
 * Store. The form goes to the account page in the browser instead.
 */
export type CustomerFormResult =
  | { ok: true }
  | { ok: false; error: string; values: { email: string; name: string } };

async function sessionToken(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return isUuid(token) ? token : null;
}

/** What the Customer typed, to fill the form again (bounded; never the password). */
function typed(formData: FormData): { email: string; name: string } {
  const text = (key: string, max: number) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.slice(0, max) : "";
  };
  return { email: text("email", MAX_EMAIL_LENGTH), name: text("name", MAX_NAME_LENGTH) };
}

/** Set the session cookie for a started session, or say why there is none. */
async function finish(
  storeId: string,
  run: () => Promise<CustomerSessionResult>,
  formData: FormData,
  what: string,
): Promise<CustomerFormResult> {
  let result: CustomerSessionResult;
  try {
    result = await run();
  } catch (error) {
    console.error(`Customer ${what} failed in Store ${storeId}: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
    return { ok: false, error: "Something went wrong. Please try again.", values: typed(formData) };
  }
  if (!result.ok) return { ok: false, error: customerFormMessage(result.reason), values: typed(formData) };
  (await cookies()).set(SESSION_COOKIE, result.token, customerSessionCookieOptions({ production: process.env.NODE_ENV === "production" }));
  return { ok: true };
}

/** Create a Customer account in the request host's Store, and sign it in. */
export async function customerSignUpAction(_previous: CustomerFormResult | null, formData: FormData): Promise<CustomerFormResult> {
  const storeId = await resolveStorefrontStore();
  if (!storeId) return { ok: false, error: "This store is not available.", values: typed(formData) };
  const previous = await sessionToken();
  const input = { email: formData.get("email"), name: formData.get("name"), password: formData.get("password") };
  return finish(storeId, () => startCustomerSignUp(storeId, input, previous), formData, "sign-up");
}

/** Sign a Customer in to the request host's Store. */
export async function customerSignInAction(_previous: CustomerFormResult | null, formData: FormData): Promise<CustomerFormResult> {
  const storeId = await resolveStorefrontStore();
  if (!storeId) return { ok: false, error: "This store is not available.", values: typed(formData) };
  const previous = await sessionToken();
  const input = { email: formData.get("email"), password: formData.get("password") };
  return finish(storeId, () => startCustomerSignIn(storeId, input, previous), formData, "sign-in");
}

/** Sign the Customer out of the request host's Store: end the session and clear the cookie. */
export async function customerSignOutAction(): Promise<{ ok: true }> {
  const storeId = await resolveStorefrontStore();
  const token = await sessionToken();
  if (storeId && token) await signOutCustomer(storeId, token);
  (await cookies()).delete({ name: SESSION_COOKIE, path: "/" });
  return { ok: true };
}

/** The signed-in Customer of the request host's Store, or null. */
export async function getStorefrontCustomer() {
  const storeId = await resolveStorefrontStore();
  if (!storeId) return null;
  const token = await sessionToken();
  if (!token) return null;
  return getCustomerBySession(storeId, token);
}

// Dashboard reads. This module is also imported by the storefront /account
// pages, so these are registered there too: each authorizes the Merchant for
// the Store first, whatever page the request is posted to.

export async function getDashboardCustomers(storeId: string) {
  await authorizeStore(storeId, "customers.view");
  return listCustomers(storeId);
}

export async function getDashboardCustomerOrders(storeId: string, customerId: string) {
  await authorizeStore(storeId, "customers.view");
  return listCustomerOrders(storeId, customerId);
}

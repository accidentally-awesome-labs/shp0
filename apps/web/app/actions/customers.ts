"use server";

import { cookies } from "next/headers";

import { authorizeStore, resolveStorefrontStore } from "@/lib/current-store";
import {
  customerFormMessage,
  CustomerSignUpError,
  getCustomerBySession,
  isUuid,
  listCustomers,
  listCustomerOrders,
  parseCustomerSignIn,
  parseCustomerSignUp,
  signInCustomer,
  signOutCustomer,
  signUpCustomer,
} from "@shp0/db";

/**
 * The Customer's session cookie (ADR-0003): a random session token in an
 * httpOnly, SameSite=Lax, host-only cookie, Secure in production builds like
 * the cart token (lib/cart-token.ts). It is a bearer secret for the
 * Customer's account in this Store.
 */
const SESSION_COOKIE = "customer_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * What a Customer form does next: the account page, or why not. Returned,
 * not thrown (a thrown error's message is a digest in production), and not
 * a redirect(): Next renders a server action's same-site redirect target
 * through an internal request without the storefront's Host, which finds no
 * Store. The form navigates in the browser instead.
 */
export type CustomerFormResult = { ok: true } | { ok: false; error: string };

const STORE_UNAVAILABLE: CustomerFormResult = { ok: false, error: "This store is not available." };

async function sessionToken(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return isUuid(token) ? token : null;
}

/** Start the Customer's session, ending the one this browser had in the Store, if any. */
async function startSession(storeId: string, token: string): Promise<void> {
  const previous = await sessionToken();
  if (previous && previous !== token) await signOutCustomer(storeId, previous);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
}

/** Create a Customer account in the request host's Store, and sign it in. */
export async function customerSignUpAction(formData: FormData): Promise<CustomerFormResult> {
  const storeId = await resolveStorefrontStore();
  if (!storeId) return STORE_UNAVAILABLE;
  const parsed = parseCustomerSignUp({
    email: formData.get("email"),
    name: formData.get("name"),
    password: formData.get("password"),
  });
  if (!parsed.ok) return { ok: false, error: customerFormMessage(parsed.reason) };

  try {
    await signUpCustomer(storeId, parsed.value);
  } catch (error) {
    if (error instanceof CustomerSignUpError) return { ok: false, error: error.message };
    throw error;
  }
  const session = await signInCustomer(storeId, parsed.value);
  if (!session) throw new Error("A Customer who just signed up could not sign in");
  await startSession(storeId, session.token);
  return { ok: true };
}

/** Sign a Customer in to the request host's Store. */
export async function customerSignInAction(formData: FormData): Promise<CustomerFormResult> {
  const storeId = await resolveStorefrontStore();
  if (!storeId) return STORE_UNAVAILABLE;
  const parsed = parseCustomerSignIn({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.ok) return { ok: false, error: customerFormMessage(parsed.reason) };

  const session = await signInCustomer(storeId, parsed.value);
  if (!session) return { ok: false, error: customerFormMessage("wrong_credentials") };
  await startSession(storeId, session.token);
  return { ok: true };
}

/** Sign the Customer out of the request host's Store: end the session and clear the cookie. */
export async function customerSignOutAction(): Promise<void> {
  const storeId = await resolveStorefrontStore();
  const token = await sessionToken();
  if (storeId && token) await signOutCustomer(storeId, token);
  (await cookies()).delete({ name: SESSION_COOKIE, path: "/" });
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

"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { resolveStorefrontStore } from "@/lib/current-store";
import {
  signUpCustomer,
  signInCustomer,
  getCustomerBySession,
  listCustomers,
  listCustomerOrders,
} from "@shp0/db";

const SESSION_COOKIE = "customer_session";

export async function customerSignUpAction(formData: FormData) {
  const storeId = await resolveStorefrontStore();
  if (!storeId) throw new Error("No store resolved");

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const name = formData.get("name") as string;

  try {
    await signUpCustomer(storeId, { email, password, name });
    // Auto sign-in after sign-up.
    const session = await signInCustomer(storeId, { email, password });
    if (session) {
      (await cookies()).set(SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60,
        path: "/",
      });
    }
  } catch {
    throw new Error("Email already registered in this store");
  }
  redirect("/account");
}

export async function customerSignInAction(formData: FormData) {
  const storeId = await resolveStorefrontStore();
  if (!storeId) throw new Error("No store resolved");

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  const session = await signInCustomer(storeId, { email, password });
  if (!session) {
    throw new Error("Invalid email or password");
  }
  (await cookies()).set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });
  redirect("/account");
}

export async function getStorefrontCustomer() {
  const storeId = await resolveStorefrontStore();
  if (!storeId) return null;
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getCustomerBySession(storeId, token);
}

export async function getDashboardCustomers(storeId: string) {
  return listCustomers(storeId);
}

export async function getDashboardCustomerOrders(storeId: string, customerId: string) {
  return listCustomerOrders(storeId, customerId);
}

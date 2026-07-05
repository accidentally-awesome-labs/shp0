"use server";

import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";

import { resolveStorefrontStore } from "@/lib/current-store";
import {
  getDbCart,
  saveDbCartLines,
  addLine,
  updateLine,
  removeLine,
  type Cart,
} from "@shp0/db";

const ANON_CART_COOKIE = "shp0_cart_token";

/**
 * Get or create the anonymous cart token (cookie). This is used as the
 * `customer_id` in the DB for now — a simple approach that works without Vercel
 * KV. When KV is set up (HITL), swap this to read/write from KV instead.
 */
async function getCartToken(): Promise<string> {
  const cookieStore = await cookies();
  let token = cookieStore.get(ANON_CART_COOKIE)?.value;
  if (!token) {
    token = randomUUID();
    cookieStore.set(ANON_CART_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
  }
  return token;
}

/**
 * Get the storeId for the current storefront request.
 * In local dev (no subdomain), returns null — cart actions need a resolved store.
 */
async function requireStoreId(): Promise<string> {
  const storeId = await resolveStorefrontStore();
  if (!storeId) throw new Error("No store resolved for this request");
  return storeId;
}

export async function addToCart(variantId: string, quantity: number = 1) {
  const storeId = await requireStoreId();
  const token = await getCartToken();

  const cart = await getDbCart(storeId, token);
  const updated = addLine(cart, { variantId, quantity });
  await saveDbCartLines(storeId, token, updated.lines);
}

export async function updateCartItem(variantId: string, quantity: number) {
  const storeId = await requireStoreId();
  const token = await getCartToken();

  const cart = await getDbCart(storeId, token);
  const updated = updateLine(cart, { variantId, quantity });
  await saveDbCartLines(storeId, token, updated.lines);
}

export async function removeCartItem(variantId: string) {
  const storeId = await requireStoreId();
  const token = await getCartToken();

  const cart = await getDbCart(storeId, token);
  const updated = removeLine(cart, variantId);
  await saveDbCartLines(storeId, token, updated.lines);
}

export async function getCart(): Promise<Cart> {
  const storeId = await requireStoreId();
  const token = await getCartToken();
  return getDbCart(storeId, token);
}

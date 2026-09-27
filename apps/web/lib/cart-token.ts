import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";

import { isUuid } from "@shp0/db";

/**
 * The anonymous cart token: a random UUID in an httpOnly, SameSite=Lax,
 * host-only cookie, minted by the first cart action on a storefront host.
 *
 * It keys the shopper's Cart (carts.customer_id) and becomes the
 * customer_id of every Order checked out from it, so it is also the proof
 * that lets a request view or pay for those Orders (getStorefrontOrder,
 * getOrderForCheckout). It is a bearer secret: never render it or send it
 * anywhere but back to its own host in the cookie.
 */
export const CART_TOKEN_COOKIE = "shp0_cart_token";

/** 30 days from when the token is minted (it is not renewed). */
const CART_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * The request's cart token, or null when it has none. A cookie value that is
 * not a UUID was not minted here and is treated as absent.
 */
export async function readCartToken(): Promise<string | null> {
  const value = (await cookies()).get(CART_TOKEN_COOKIE)?.value;
  return isUuid(value) ? value : null;
}

/**
 * The request's cart token, minting and setting one if it has none. Only a
 * server action or route handler can set cookies, so pages use readCartToken.
 */
export async function getOrCreateCartToken(): Promise<string> {
  const existing = await readCartToken();
  if (existing !== null) return existing;
  const token = randomUUID();
  (await cookies()).set(CART_TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: CART_TOKEN_MAX_AGE_SECONDS,
  });
  return token;
}

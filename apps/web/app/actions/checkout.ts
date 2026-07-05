"use server";

import { cookies } from "next/headers";
import { checkout } from "@shp0/db";
import { resolveStorefrontStore } from "@/lib/current-store";

export async function checkoutAction() {
  const storeId = await resolveStorefrontStore();
  if (!storeId) throw new Error("No store resolved");

  const cookieStore = await cookies();
  const token = cookieStore.get("shp0_cart_token")?.value;
  if (!token) throw new Error("No cart to checkout");

  const result = await checkout(storeId, token);
  return result;
}

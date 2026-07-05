"use server";

import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { resolveDashboardStore } from "@/lib/current-store";
import { getStoreTier, setStoreTier, getStoreUsage } from "@shp0/db";
import { TIERS } from "@shp0/db";

export async function changeTierAction(storeId: string, formData: FormData) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");

  const tierId = formData.get("tierId") as "free" | "pro" | "scale";
  await setStoreTier(storeId, tierId);
}

export async function getDashboardBilling(storeId: string) {
  const [tier, usage] = await Promise.all([getStoreTier(storeId), getStoreUsage(storeId)]);
  return { tier, usage, tiers: TIERS };
}

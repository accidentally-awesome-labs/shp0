"use server";

import { authorizeStore } from "@/lib/current-store";
import { getStoreTier, setStoreTier, getStoreUsage, TIERS } from "@shp0/db";

// Platform billing is the Owner's alone (CONTEXT.md). Viewing it is Owner-only
// too: CONTEXT.md is silent on viewing, and that choice awaits the owner's
// decision (see packages/db/src/roles.ts, "billing.view").

export async function changeTierAction(storeId: string, formData: FormData) {
  await authorizeStore(storeId, "billing.manage");

  const tierId = formData.get("tierId");
  if (typeof tierId !== "string" || !Object.hasOwn(TIERS, tierId)) {
    throw new Error("Unknown tier");
  }
  await setStoreTier(storeId, tierId as keyof typeof TIERS);
}

export async function getDashboardBilling(storeId: string) {
  await authorizeStore(storeId, "billing.view");
  const [tier, usage] = await Promise.all([getStoreTier(storeId), getStoreUsage(storeId)]);
  return { tier, usage, tiers: TIERS };
}

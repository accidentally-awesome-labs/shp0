"use server";

import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { resolveDashboardStore } from "@/lib/current-store";
import {
  createDiscount as dbCreateDiscount,
  listDiscounts as dbListDiscounts,
  applyDiscounts,
} from "@shp0/db";
import type { DiscountReward } from "@shp0/db";

function slugify(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 20);
}

export async function createDiscountAction(storeId: string, formData: FormData) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");

  const name = formData.get("name") as string;
  const code = (formData.get("code") as string) || slugify(name);
  const triggerType = formData.get("triggerType") as string;
  const rewardType = formData.get("rewardType") as string;
  const percent = formData.get("percent") as string;
  const amount = formData.get("amount") as string;

  let reward: DiscountReward;
  if (rewardType === "order_percent") {
    reward = { kind: "order_percent", percent: parseFloat(percent) };
  } else if (rewardType === "order_fixed") {
    reward = { kind: "order_fixed", amountCents: Math.round(parseFloat(amount) * 100) };
  } else if (rewardType === "free_shipping") {
    reward = { kind: "free_shipping" };
  } else {
    reward = { kind: "order_percent", percent: 10 };
  }

  const trigger = triggerType === "automatic"
    ? { type: "automatic" }
    : { type: "code", code };

  const usageLimit = formData.get("usageLimit") as string;
  const conditions: { usageLimit?: number } = {};
  if (usageLimit) conditions.usageLimit = parseInt(usageLimit);

  await dbCreateDiscount(storeId, {
    name,
    trigger,
    reward,
    conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
  });
}

export async function getDashboardDiscounts(storeId: string) {
  return dbListDiscounts(storeId);
}

/**
 * Preview a discount on a sample cart (the lever that keeps the engine intuitive).
 * This is the dashboard preview — calls the pure stacking engine.
 */export async function previewDiscountAction(
  storeId: string,
  formData: FormData,
): Promise<{ finalTotalCents: number; totalDiscountCents: number }> {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");

  const sampleTotal = parseFloat(formData.get("sampleTotal") as string) * 100;
  const rewardType = formData.get("rewardType") as string;
  const percent = formData.get("percent") as string;
  const amount = formData.get("amount") as string;

  let reward: DiscountReward;
  if (rewardType === "order_percent") {
    reward = { kind: "order_percent", percent: parseFloat(percent) };
  } else if (rewardType === "order_fixed") {
    reward = { kind: "order_fixed", amountCents: Math.round(parseFloat(amount) * 100) };
  } else {
    reward = { kind: "free_shipping" };
  }

  const result = applyDiscounts(
    {
      lines: [{ productId: "sample", variantId: "sample", quantity: 1, unitPriceCents: sampleTotal }],
      shippingCents: rewardType === "free_shipping" ? 1500 : 0,
    },
    [reward],
  );

  return {
    finalTotalCents: result.finalTotalCents,
    totalDiscountCents: result.totalDiscountCents,
  };
}

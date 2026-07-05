"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import { resolveDashboardStore } from "@/lib/current-store";
import {
  createCollection as dbCreateCollection,
  listCollections as dbListCollections,
  addCollectionMembers as dbAddMembers,
  removeCollectionMember as dbRemoveMember,
  listCollectionMembers as dbListMembers,
  listProducts as dbListProducts,
} from "@shp0/db";
import type { CollectionRule } from "@shp0/db";

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export async function createCollectionAction(storeId: string, formData: FormData) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");

  const name = formData.get("name") as string;
  const slug = (formData.get("slug") as string) || slugify(name);
  const type = formData.get("type") as "manual" | "automated";

  let rule: CollectionRule | undefined;
  if (type === "automated") {
    const ruleType = formData.get("ruleType") as string;
    if (ruleType === "tag") {
      rule = { type: "tag", tag: formData.get("tag") as string };
    } else if (ruleType === "price_range") {
      const minInput = formData.get("minPrice") as string;
      const maxInput = formData.get("maxPrice") as string;
      const rulePart: { type: "price_range"; minCents?: number; maxCents?: number } = { type: "price_range" };
      if (minInput) rulePart.minCents = Math.round(parseFloat(minInput) * 100);
      if (maxInput) rulePart.maxCents = Math.round(parseFloat(maxInput) * 100);
      rule = rulePart;
    }
  }

  await dbCreateCollection(storeId, { name, slug, type, rule });
}

export async function addCollectionMembersAction(
  storeId: string,
  collectionId: string,
  productIds: string[],
) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");

  await dbAddMembers(storeId, collectionId, productIds);
}

export async function removeCollectionMemberAction(
  storeId: string,
  collectionId: string,
  productId: string,
) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");

  await dbRemoveMember(storeId, collectionId, productId);
}

export async function getDashboardCollections(storeId: string) {
  return dbListCollections(storeId);
}

export async function getDashboardCollectionMembers(storeId: string, collectionId: string) {
  return dbListMembers(storeId, collectionId);
}

export async function getDashboardProducts(storeId: string) {
  return dbListProducts(storeId);
}

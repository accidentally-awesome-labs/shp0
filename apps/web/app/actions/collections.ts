"use server";

import { authorizeStore } from "@/lib/current-store";
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

// Every export is a public endpoint (callable by action id with any
// arguments): each authorizes the caller for the Store and capability first.
// The Collection and Product ids are then scoped to that Store by RLS.

export async function createCollectionAction(storeId: string, formData: FormData) {
  await authorizeStore(storeId, "catalog.manage");

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
  await authorizeStore(storeId, "catalog.manage");
  await dbAddMembers(storeId, collectionId, productIds);
}

export async function removeCollectionMemberAction(
  storeId: string,
  collectionId: string,
  productId: string,
) {
  await authorizeStore(storeId, "catalog.manage");
  await dbRemoveMember(storeId, collectionId, productId);
}

export async function getDashboardCollections(storeId: string) {
  await authorizeStore(storeId, "catalog.view");
  return dbListCollections(storeId);
}

export async function getDashboardCollectionMembers(storeId: string, collectionId: string) {
  await authorizeStore(storeId, "catalog.view");
  return dbListMembers(storeId, collectionId);
}

export async function getDashboardProducts(storeId: string) {
  await authorizeStore(storeId, "catalog.view");
  return dbListProducts(storeId);
}

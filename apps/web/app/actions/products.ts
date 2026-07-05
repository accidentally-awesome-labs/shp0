"use server";

import { headers } from "next/headers";
import { revalidatePath, revalidateTag } from "next/cache";

import { auth } from "@/lib/auth";
import { resolveDashboardStore } from "@/lib/current-store";
import {
  createProduct as dbCreateProduct,
  listProducts as dbListProducts,
  deleteProduct as dbDeleteProduct,
  parseMoney,
  productTag,
  storeProductsTag,
} from "@shp0/db";

export async function createProductAction(storeId: string, formData: FormData) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");

  const title = formData.get("title") as string;
  const slug = (formData.get("slug") as string) || slugify(title);
  const priceInput = formData.get("price") as string;
  const priceCents = parseMoney(priceInput, "USD");

  const result = await dbCreateProduct(storeId, {
    title,
    slug,
    description: (formData.get("description") as string) ?? "",
    status: "published",
    variants: [
      {
        sku: (formData.get("sku") as string) || slug,
        title: "Default",
        priceCents,
        inventory: Number(formData.get("inventory") as string) || 0,
      },
    ],
  });

  // Targeted cache invalidation: bust this product's tag + the listing tag.
  revalidateTag(productTag(storeId, result.id), "default");
  revalidateTag(storeProductsTag(storeId), "default");
  revalidatePath(`/dashboard/${storeId}/products`);
  return result;
}

export async function deleteProductAction(storeId: string, productId: string) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");

  await dbDeleteProduct(storeId, productId);
  // Targeted cache invalidation.
  revalidateTag(productTag(storeId, productId), "default");
  revalidateTag(storeProductsTag(storeId), "default");
  revalidatePath(`/dashboard/${storeId}/products`);
}

export async function getProducts(storeId: string) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) return [];
  return dbListProducts(storeId);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}


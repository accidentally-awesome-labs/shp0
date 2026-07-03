"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { provisionStore, listMemberships, checkSubdomainAvailable } from "@shp0/db";

export async function createStoreAction(formData: FormData) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");

  const name = formData.get("name") as string;
  const subdomain = (formData.get("subdomain") as string).toLowerCase().trim();

  if (!name || !subdomain) throw new Error("Name and subdomain are required");

  const { store } = await provisionStore({
    name,
    subdomain,
    ownerId: session.user.id,
  });

  revalidatePath("/dashboard");
  return { storeId: store.id };
}

export async function getMyStores() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return [];
  return listMemberships(session.user.id);
}

export async function checkSubdomain(subdomain: string) {
  const available = await checkSubdomainAvailable(
    subdomain.toLowerCase().trim(),
  );
  return { available };
}

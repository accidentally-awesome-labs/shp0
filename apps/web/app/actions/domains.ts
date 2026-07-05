"use server";

import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { resolveDashboardStore } from "@/lib/current-store";
import { addCustomDomain, listCustomDomains, applyDomainVerification } from "@shp0/db";

export async function addDomainAction(storeId: string, formData: FormData) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");

  const hostname = formData.get("hostname") as string;
  await addCustomDomain(storeId, hostname);
}

export async function verifyDomainAction(domainId: string) {
  // Manual verify trigger (in production: the DNS check job does this).
  await applyDomainVerification(domainId, "dns_ok");
}

export async function retryDomainAction(domainId: string) {
  await applyDomainVerification(domainId, "retry");
}

export async function getDashboardDomains(storeId: string) {
  return listCustomDomains(storeId);
}
